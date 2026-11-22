import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  guardDecision,
  recordGuard,
  serialQueue,
  type GuardStats,
  type PageRead,
  type SiteBrowser,
  type SiteBrowserOptions,
} from "./site-browser.ts";

export type { GuardStats } from "./site-browser.ts";
export type IsolatedBrowserOptions = SiteBrowserOptions;

/** The isolated profile as a Playwright-driven Chromium, with the network guard in front of it. */
export class IsolatedBrowser implements SiteBrowser {
  readonly #context: BrowserContext;
  readonly #serial = serialQueue();
  #taskMode = false;
  readonly stats: GuardStats = { offOrigin: 0, blockedPath: 0, blockedMethod: 0, blockedPaths: [] };

  private constructor(context: BrowserContext) {
    this.#context = context;
  }

  static async launch(options: SiteBrowserOptions): Promise<IsolatedBrowser> {
    mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless ?? true,
      executablePath: process.env.AGENTBNB_CHROMIUM_PATH || undefined,
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
    });
    const browser = new IsolatedBrowser(context);
    const origin = new URL(options.allowedOrigin).origin;
    await context.route("**/*", (route) => {
      const request = route.request();
      const decision = guardDecision(
        { url: request.url(), method: request.method() },
        { origin, blockedPathPrefixes: options.blockedPathPrefixes, taskMode: browser.#taskMode },
      );
      if (decision === "allow") return route.continue();
      recordGuard(browser.stats, decision, request.url());
      return route.abort("blockedbyclient");
    });
    return browser;
  }

  #withPage<T>(taskMode: boolean, fn: (page: Page) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const page = await this.#context.newPage();
      this.#taskMode = taskMode;
      try {
        return await fn(page);
      } finally {
        this.#taskMode = false;
        await page.close().catch(() => undefined);
      }
    });
  }

  read(request: { url: string; container: string; selectors: Readonly<Record<string, string>> }): Promise<PageRead> {
    return this.#withPage(true, async (page) => {
      const response = await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const container = page.locator(request.container);
      const matches = await container.count();
      const values: Record<string, string> = {};
      if (matches === 1) {
        for (const [name, selector] of Object.entries(request.selectors)) {
          const node = container.locator(selector);
          if ((await node.count()) === 1) values[name] = (await node.textContent()) ?? "";
        }
      }
      return { finalUrl: page.url(), status: response?.status() ?? 0, matches, values };
    });
  }

  visit(url: string): Promise<{ finalUrl: string; status: number }> {
    return this.#withPage(false, async (page) => {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      return { finalUrl: page.url(), status: response?.status() ?? 0 };
    });
  }

  submitForm(request: { url: string; fields: Readonly<Record<string, string>>; submit: string }): Promise<{ finalUrl: string }> {
    return this.#withPage(false, async (page) => {
      await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      for (const [selector, value] of Object.entries(request.fields)) await page.fill(selector, value);
      const start = page.url();
      await Promise.all([page.waitForURL((url) => url.href !== start, { timeout: 15_000 }), page.click(request.submit)]);
      return { finalUrl: page.url() };
    });
  }

  async close(): Promise<void> {
    await this.#context.close();
  }
}
