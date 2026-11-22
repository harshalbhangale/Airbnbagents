import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectToMarketplace, type MarketplaceLink } from "./connection.ts";
import { HostWorker, type HostWorkerOptions } from "./worker.ts";

export type MarketplaceStatus = "off" | "connecting" | "connected" | "disconnected" | "refused";

export interface HostAppOptions extends HostWorkerOptions {
  /** ws:// or wss:// address of the marketplace's host endpoint. */
  marketplaceUrl?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Everything a host runs, in one object: the worker, its link to the
 * marketplace, and the few settings that are not privacy rules or prices.
 * The dashboard and the command line both drive this.
 */
export class HostApp {
  readonly worker: HostWorker;
  readonly marketplaceUrl: string | null;
  readonly #settingsFile: string;
  #payoutAddress: string | null;
  #link: MarketplaceLink | null = null;
  #status: MarketplaceStatus = "off";
  #signedIn = false;

  private constructor(worker: HostWorker, options: HostAppOptions, settingsFile: string, payoutAddress: string | null) {
    this.worker = worker;
    this.marketplaceUrl = options.marketplaceUrl ?? null;
    this.#settingsFile = settingsFile;
    this.#payoutAddress = payoutAddress;
  }

  static async start(options: HostAppOptions): Promise<HostApp> {
    const worker = await HostWorker.start(options);
    const settingsFile = join(options.dataDir, "settings.json");
    let payout: string | null = null;
    if (existsSync(settingsFile)) {
      const stored = JSON.parse(readFileSync(settingsFile, "utf8")) as { payoutAddress?: unknown };
      if (typeof stored.payoutAddress === "string" && ADDRESS.test(stored.payoutAddress)) payout = stored.payoutAddress;
    }
    const app = new HostApp(worker, options, settingsFile, payout);
    app.#signedIn = await worker.isSignedIn().catch(() => false);
    app.#connect();
    return app;
  }

  /** The worker goes on the marketplace only once there is somewhere to pay it. */
  #connect(): void {
    this.#link?.close();
    this.#link = null;
    if (!this.marketplaceUrl || !this.#payoutAddress) {
      this.#status = "off";
      return;
    }
    this.#status = "connecting";
    const link = connectToMarketplace(this.worker, {
      url: this.marketplaceUrl,
      payoutAddress: this.#payoutAddress,
      onStatus: (status) => {
        if (this.#link === link) this.#status = status;
      },
    });
    this.#link = link;
  }

  get marketplaceStatus(): MarketplaceStatus {
    return this.#status;
  }

  get payoutAddress(): string | null {
    return this.#payoutAddress;
  }

  /** Resolves once the marketplace has accepted the worker. Rejects if it is not set up to connect. */
  whenConnected(): Promise<void> {
    return this.#link ? this.#link.ready : Promise.reject(new Error("not connecting: set a payout address and a marketplace"));
  }

  setPayoutAddress(address: string): void {
    if (!ADDRESS.test(address)) throw new RangeError("payout address must be an EVM address");
    this.#payoutAddress = address;
    writeFileSync(this.#settingsFile, JSON.stringify({ payoutAddress: address }, null, 2), { mode: 0o600 });
    this.#connect();
  }

  /** Call after changing rules or prices so the marketplace shows the new listing. */
  announce(): void {
    this.#link?.refresh();
  }

  get signedIn(): boolean {
    return this.#signedIn;
  }

  async signIn(email: string, password: string): Promise<boolean> {
    this.#signedIn = await this.worker.signIn(email, password);
    return this.#signedIn;
  }

  async recheckSignIn(): Promise<boolean> {
    this.#signedIn = await this.worker.isSignedIn().catch(() => false);
    return this.#signedIn;
  }

  async close(): Promise<void> {
    this.#link?.close();
    await this.worker.close();
  }
}
