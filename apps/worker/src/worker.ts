import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES } from "@agentbnb/protocol";
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

  private constructor(layer: PrivacyLayer, browser: IsolatedBrowser, audit: AuditLog, policyFile: string, origin: string) {
    this.#layer = layer;
    this.#browser = browser;
    this.#audit = audit;
    this.#policyFile = policyFile;
    this.#origin = origin;
  }

  static async start(options: HostWorkerOptions): Promise<HostWorker> {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    const origin = new URL(options.siteOrigin).origin;
    const keys = await WorkerKeys.loadOrCreate(options.dataDir);
    const audit = new AuditLog(join(options.dataDir, "audit.jsonl"));
    const policyFile = join(options.dataDir, "policy.json");
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
      return new HostWorker(layer, browser, audit, policyFile, origin);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  /** The one entry point for rented work. */
  handle(sealedRequest: unknown): Promise<SealedOutput> {
    return this.#layer.handle(sealedRequest);
  }

  listing(): Listing {
    return this.#layer.listing();
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
