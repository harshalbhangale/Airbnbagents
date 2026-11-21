import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";

export interface IsolatedBrowserOptions {
  /** A browser profile used for rented tasks only. The host's everyday browser is never touched. */
  profileDir: string;
  /** The one site this profile may talk to. Every other origin is refused. */
  allowedOrigin: string;
  /** Path prefixes that are refused even on the allowed site. */
  blockedPathPrefixes: readonly string[];
  headless?: boolean;
}

export interface GuardStats {
  offOrigin: number;
  blockedPath: number;
  blockedMethod: number;
  /** Paths (never query strings or bodies) of refused same-site requests. */
  blockedPaths: string[];
}

/**
 * A Chromium profile with a network guard in front of it. The guard is the
 * backstop behind the fixed task code: even if a page tries to load the inbox
 * on its own, the request never leaves the browser.
 */
export class IsolatedBrowser {
  readonly #context: BrowserContext;
  readonly #origin: string;
  readonly #blocked: readonly string[];
  #taskMode = false;
  #queue: Promise<unknown> = Promise.resolve();
  readonly stats: GuardStats = { offOrigin: 0, blockedPath: 0, blockedMethod: 0, blockedPaths: [] };

  private constructor(context: BrowserContext, origin: string, blocked: readonly string[]) {
    this.#context = context;
    this.#origin = origin;
    this.#blocked = blocked;
  }

  static async launch(options: IsolatedBrowserOptions): Promise<IsolatedBrowser> {
    mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless ?? true,
      executablePath: process.env.AGENTBNB_CHROMIUM_PATH || undefined,
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
    });
    const browser = new IsolatedBrowser(context, new URL(options.allowedOrigin).origin, options.blockedPathPrefixes);
    await context.route("**/*", (route) => {
      const request = route.request();
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        browser.stats.offOrigin++;
        return route.abort("blockedbyclient");
      }
      if (url.origin !== browser.#origin) {
        browser.stats.offOrigin++;
        return route.abort("blockedbyclient");
      }
      if (browser.#blocked.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
        browser.stats.blockedPath++;
        browser.stats.blockedPaths.push(url.pathname);
        return route.abort("blockedbyclient");
      }
      // Rented tasks are read-only: nothing is submitted, posted or changed on the host's account.
      if (browser.#taskMode && request.method() !== "GET") {
        browser.stats.blockedMethod++;
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    return browser;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Runs one task in a fresh tab, one at a time, and closes the tab afterwards. */
  withTaskPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const page = await this.#context.newPage();
      this.#taskMode = true;
      try {
        return await fn(page);
      } finally {
        this.#taskMode = false;
        await page.close().catch(() => undefined);
      }
    });
  }

  /** For the host's own setup steps, such as signing in. Still limited to the allowed site and paths. */
  withSetupPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const page = await this.#context.newPage();
      try {
        return await fn(page);
      } finally {
        await page.close().catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    await this.#context.close();
  }
}
