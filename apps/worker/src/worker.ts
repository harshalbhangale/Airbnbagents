import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, isBlockedCapability, utf8 } from "@agentbnb/protocol";
import { EarningsLedger, OfferError, parseOffers, split, usd, type Earning, type EarningsSummary, type Offer } from "@agentbnb/pricing";
import {
  AuditLog,
  PrivacyLayer,
  WorkerKeys,
  defaultPolicy,
  type AuditEntry,
  type HostPolicy,
  type Listing,
  type SealedOutput,
} from "@agentbnb/privacy";
import type { GuardStats, SiteBrowser, SiteBrowserOptions } from "./site-browser.ts";
import type { ReportedSettlement, SettlementVerifier } from "./settlement.ts";
import { profileReadExecutor } from "./capabilities/profile-read.ts";

export interface HostWorkerOptions {
  /** Where the worker keeps its keys, rules, audit log and isolated browser profile. */
  dataDir: string;
  /** The site the rented account lives on. */
  siteOrigin: string;
  headless?: boolean;
  now?: () => number;
  /**
   * Supplies the isolated browser. Defaults to a Playwright-driven Chromium;
   * the desktop app passes its own built-in browser instead.
   */
  createBrowser?: (options: SiteBrowserOptions) => Promise<SiteBrowser>;
  /**
   * Checks reported payments against the chain. Without it, earnings stay
   * marked as awaiting confirmation.
   */
  verifySettlement?: SettlementVerifier;
  /** How long to wait between attempts when a payment cannot be checked yet. */
  verifyRetryMs?: number;
}

/** A worker's public listing: what it can do, on what terms, and at what price. */
export interface WorkerListing extends Listing {
  offers: Offer[];
}

/** Products this version of the worker can actually deliver. The others can be priced once they exist. */
const DELIVERABLE: ReadonlySet<Offer["kind"]> = new Set(["automation_session"]);

const DEFAULT_OFFERS: readonly Offer[] = [
  { kind: "automation_session", capability: "profile.read", pricePerSession: usd(0.02) },
];

function checkOffers(raw: unknown): Offer[] {
  const offers = parseOffers(raw);
  for (const offer of offers) {
    if (!DELIVERABLE.has(offer.kind)) throw new OfferError(`${offer.kind} cannot be offered yet: this worker cannot deliver it`);
    if (offer.kind === "automation_session") {
      if (isBlockedCapability(offer.capability)) throw new OfferError(`${offer.capability} can never be offered`);
      if (!CAPABILITIES[offer.capability]) throw new OfferError(`unknown capability: ${offer.capability}`);
    }
  }
  return offers;
}

/** Parts of the site the isolated browser refuses to load at all. */
const BLOCKED_PATHS = ["/messages", "/api/messages", "/settings", "/logout"] as const;

/**
 * The program a host runs. It owns the isolated browser and the privacy layer,
 * and exposes exactly one way to do work: hand it an encrypted task, get back
 * an encrypted, signed answer.
 */
export class HostWorker {
  readonly #layer: PrivacyLayer;
  readonly #browser: SiteBrowser;
  readonly #audit: AuditLog;
  readonly #policyFile: string;
  readonly #origin: string;
  readonly #offersFile: string;
  readonly #ledger: EarningsLedger;
  readonly #keys: WorkerKeys;
  readonly #verify: SettlementVerifier | undefined;
  readonly #verifyRetryMs: number;
  #closed = false;
  #offers: Offer[];

  private constructor(
    keys: WorkerKeys,
    layer: PrivacyLayer,
    browser: SiteBrowser,
    audit: AuditLog,
    origin: string,
    files: { policy: string; offers: string; earnings: string },
    offers: Offer[],
    options: HostWorkerOptions,
  ) {
    this.#verify = options.verifySettlement;
    this.#verifyRetryMs = options.verifyRetryMs ?? 3_000;
    this.#keys = keys;
    this.#layer = layer;
    this.#browser = browser;
    this.#audit = audit;
    this.#policyFile = files.policy;
    this.#offersFile = files.offers;
    this.#ledger = new EarningsLedger(files.earnings);
    this.#origin = origin;
    this.#offers = offers;
  }

  static async start(options: HostWorkerOptions): Promise<HostWorker> {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    const origin = new URL(options.siteOrigin).origin;
    const keys = await WorkerKeys.loadOrCreate(options.dataDir);
    const audit = new AuditLog(join(options.dataDir, "audit.jsonl"));
    const policyFile = join(options.dataDir, "policy.json");
    const offersFile = join(options.dataDir, "offers.json");
    const offers = checkOffers(existsSync(offersFile) ? JSON.parse(readFileSync(offersFile, "utf8")) : DEFAULT_OFFERS);
    const policy: unknown = existsSync(policyFile)
      ? JSON.parse(readFileSync(policyFile, "utf8"))
      : defaultPolicy(CAPABILITIES);

    const browserOptions: SiteBrowserOptions = {
      profileDir: join(options.dataDir, "browser-profile"),
      allowedOrigin: origin,
      blockedPathPrefixes: BLOCKED_PATHS,
      headless: options.headless,
    };
    // Loaded on demand so an app that brings its own browser does not need Playwright installed.
    const browser = options.createBrowser
      ? await options.createBrowser(browserOptions)
      : await (await import("./browser.ts")).IsolatedBrowser.launch(browserOptions);
    try {
      const layer = new PrivacyLayer({
        keys,
        policy,
        registry: CAPABILITIES,
        executors: { "profile.read": profileReadExecutor(browser, origin) },
        audit,
        now: options.now,
      });
      const files = { policy: policyFile, offers: offersFile, earnings: join(options.dataDir, "earnings.jsonl") };
      return new HostWorker(keys, layer, browser, audit, origin, files, offers, options);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  /** The one entry point for rented work. */
  handle(sealedRequest: unknown): Promise<SealedOutput> {
    return this.#layer.handle(sealedRequest);
  }

  /** Capabilities that are switched on, with the host's price for each. */
  listing(): WorkerListing {
    const listing = this.#layer.listing();
    const enabled = new Set(listing.capabilities.map((capability) => capability.id));
    return {
      ...listing,
      offers: this.#offers.filter((offer) => offer.kind !== "automation_session" || enabled.has(offer.capability)),
    };
  }

  get offers(): Offer[] {
    return structuredClone(this.#offers);
  }

  /** Changes the host's prices and saves them. Invalid or undeliverable offers are refused and nothing changes. */
  setOffers(raw: unknown): void {
    this.#offers = checkOffers(raw);
    writeFileSync(this.#offersFile, JSON.stringify(this.#offers, null, 2), { mode: 0o600 });
  }

  /** Money actually received. Stays at zero until payments are settled through the marketplace. */
  earnings(since = 0): EarningsSummary {
    return this.#ledger.summary(since);
  }

  /** Every recorded payment, newest first. */
  payments(): Earning[] {
    return this.#ledger.entries();
  }

  /**
   * Records a payment the marketplace reports as settled, then checks it
   * against the chain in the background. Until that check succeeds the
   * payment is shown as awaiting confirmation; if the transaction turns out
   * not to pay the host what was claimed, it is marked failed and counts for
   * nothing. Returns false if the payment was already recorded.
   */
  recordSettlement(settlement: ReportedSettlement & { at: number }): boolean {
    const paymentId = `${settlement.network}:${settlement.transaction}`;
    const added = this.#ledger.record(
      paymentId,
      "automation_session",
      { ...split(settlement.amount, 0), quantity: 1, unit: "session" },
      settlement.at,
    );
    if (added && this.#verify) void this.#confirm(paymentId, settlement);
    return added;
  }

  async #confirm(paymentId: string, settlement: ReportedSettlement): Promise<void> {
    for (let attempt = 0; attempt < 6 && !this.#closed; attempt++) {
      const check = await this.#verify!(settlement).catch(() => "unknown" as const);
      if (this.#closed) return;
      if (check === "confirmed") return void this.#ledger.resolve(paymentId, "confirmed");
      if (check === "mismatch") return void this.#ledger.resolve(paymentId, "failed");
      await new Promise((resolve) => setTimeout(resolve, this.#verifyRetryMs).unref?.());
    }
  }

  /** Proves to a marketplace that this worker holds the signing key in its listing. Never used for receipts. */
  signMarketplaceAuth(nonce: string, listingHash: string): string {
    return this.#keys.sign(utf8(`agentbnb/v1/host-auth\n${nonce}\n${listingHash}`));
  }

  get policy(): HostPolicy {
    return this.#layer.policy;
  }

  /** Changes the host's rules and saves them. Invalid rules are refused and nothing changes. */
  setPolicy(policy: unknown): void {
    this.#layer.setPolicy(policy);
    writeFileSync(this.#policyFile, JSON.stringify(this.#layer.policy, null, 2), { mode: 0o600 });
  }

  pause(): void {
    this.#layer.pause();
  }

  resume(): void {
    this.#layer.resume();
  }

  auditEntries(): readonly AuditEntry[] {
    return this.#audit.entries();
  }

  auditIntact(): boolean {
    return this.#audit.verify();
  }

  guardStats(): Readonly<GuardStats> {
    return this.#browser.stats;
  }

  /**
   * Signs the isolated profile in to the site. The credentials go straight
   * into the site's own sign-in form inside the isolated browser; the worker
   * does not store them and they are never sent anywhere else.
   */
  async signIn(email: string, password: string): Promise<boolean> {
    if (!this.#browser.submitForm) throw new Error("this browser signs in through its own window");
    const { finalUrl } = await this.#browser.submitForm({
      url: `${this.#origin}/login`,
      fields: { 'input[name="email"]': email, 'input[name="password"]': password },
      submit: 'button[type="submit"]',
    });
    return new URL(finalUrl).pathname === "/feed";
  }

  /** True when the host can sign in through a window of their own rather than by handing over details. */
  get hasSignInWindow(): boolean {
    return typeof this.#browser.openSignIn === "function";
  }

  /** Opens the sign-in window and waits until the host has finished with it. */
  async openSignInWindow(): Promise<void> {
    if (!this.#browser.openSignIn) throw new Error("this browser has no sign-in window");
    await this.#browser.openSignIn(`${this.#origin}/login`);
  }

  /** Whether the isolated profile currently has a signed-in session on the site. */
  async isSignedIn(): Promise<boolean> {
    const { finalUrl } = await this.#browser.visit(`${this.#origin}/feed`);
    return new URL(finalUrl).pathname === "/feed";
  }

  get paused(): boolean {
    return this.#layer.paused;
  }

  get siteOrigin(): string {
    return this.#origin;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#browser.close();
  }
}
