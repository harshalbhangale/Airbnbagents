import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, isBlockedCapability, utf8 } from "@agentbnb/protocol";
import { EarningsLedger, OfferError, parseOffers, split, usd, type EarningsSummary, type Offer } from "@agentbnb/pricing";
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
import { IsolatedBrowser, type GuardStats } from "./browser.ts";
import { profileReadExecutor } from "./capabilities/profile-read.ts";

export interface HostWorkerOptions {
  /** Where the worker keeps its keys, rules, audit log and isolated browser profile. */
  dataDir: string;
  /** The site the rented account lives on. */
  siteOrigin: string;
  headless?: boolean;
  now?: () => number;
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
  readonly #browser: IsolatedBrowser;
  readonly #audit: AuditLog;
  readonly #policyFile: string;
  readonly #origin: string;
  readonly #offersFile: string;
  readonly #ledger: EarningsLedger;
  readonly #keys: WorkerKeys;
  #offers: Offer[];

  private constructor(
    keys: WorkerKeys,
    layer: PrivacyLayer,
    browser: IsolatedBrowser,
    audit: AuditLog,
    origin: string,
    files: { policy: string; offers: string; earnings: string },
    offers: Offer[],
  ) {
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

    const browser = await IsolatedBrowser.launch({
      profileDir: join(options.dataDir, "browser-profile"),
      allowedOrigin: origin,
      blockedPathPrefixes: BLOCKED_PATHS,
      headless: options.headless,
    });
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
      return new HostWorker(keys, layer, browser, audit, origin, files, offers);
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
  earnings(): EarningsSummary {
    return this.#ledger.summary();
  }

  /**
   * Records a payment the marketplace reports as settled onchain, straight to
   * the host's payout address. Returns false if it was already recorded.
   * The report is taken on trust for now; checking the transaction onchain is
   * still to be added.
   */
  recordSettlement(settlement: { network: string; transaction: string; amount: number; at: number }): boolean {
    return this.#ledger.record(
      `${settlement.network}:${settlement.transaction}`,
      "automation_session",
      { ...split(settlement.amount, 0), quantity: 1, unit: "session" },
      settlement.at,
    );
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
    return this.#browser.withSetupPage(async (page) => {
      await page.goto(`${this.#origin}/login`, { waitUntil: "domcontentloaded" });
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', password);
      await Promise.all([page.waitForURL((url) => url.pathname !== "/login" || url.search !== ""), page.click('button[type="submit"]')]);
      return new URL(page.url()).pathname === "/feed";
    });
  }

  async close(): Promise<void> {
    await this.#browser.close();
  }
}
