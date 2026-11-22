import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page, type Request } from "playwright";
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

/**
 * The browser flag that makes every host name unresolvable except the ones the
 * isolated profile legitimately needs: the allowed site, and any network proxy
 * the machine is configured to use. Without the proxy exception the browser
 * cannot reach the proxy at all and nothing loads.
 *
 * Behind a proxy this layer does less, because the proxy looks names up, not
 * the browser. Requests to other sites are then stopped by interception alone.
 */
export function resolverRules(siteHostname: string, env: NodeJS.ProcessEnv = process.env): string {
  const allowed = new Set([siteHostname]);
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = env[name];
    if (!value) continue;
    try {
      const { hostname } = new URL(value.includes("://") ? value : `http://${value}`);
      if (hostname) allowed.add(hostname.replace(/^\[|\]$/g, ""));
    } catch {
      /* not a usable proxy address: nothing to allow */
    }
  }
  return `MAP * ~NOTFOUND${[...allowed].map((host) => `, EXCLUDE ${host}`).join("")}`;
}

/**
 * The isolated profile as a Playwright-driven Chromium.
 *
 * The network guard has to fail closed. Intercepting requests from outside
 * the browser does not: if a tab closes while a request is still being held
 * for a decision, Chromium lets that request go. So the rules are enforced in
 * layers that do not depend on the worker answering in time:
 *
 *  - blocked paths are blocked inside the browser itself, per tab;
 *  - every hostname other than the allowed site's is made unresolvable;
 *  - interception still judges every request (it is what stops non-GET
 *    requests during tasks and other sites addressed by raw IP), and a tab is
 *    never closed while a decision is outstanding: it is first sent to a blank
 *    page, which cancels whatever it was loading.
 */
export class IsolatedBrowser implements SiteBrowser {
  readonly #context: BrowserContext;
  readonly #origin: string;
  readonly #blocked: readonly string[];
  readonly #serial = serialQueue();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #counted = new WeakSet<Request>();
  #taskMode = false;
  readonly stats: GuardStats = { offOrigin: 0, blockedPath: 0, blockedMethod: 0, blockedPaths: [] };

  private constructor(context: BrowserContext, origin: string, blocked: readonly string[]) {
    this.#context = context;
    this.#origin = origin;
    this.#blocked = blocked;
  }

  static async launch(options: SiteBrowserOptions): Promise<IsolatedBrowser> {
    mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
    const origin = new URL(options.allowedOrigin).origin;
    const { hostname } = new URL(origin);
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless ?? true,
      executablePath: process.env.AGENTBNB_CHROMIUM_PATH || undefined,
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
      args: [`--host-resolver-rules=${resolverRules(hostname)}`],
    });
    const browser = new IsolatedBrowser(context, origin, options.blockedPathPrefixes);

    await context.route("**/*", (route) => {
      const request = route.request();
      const decision = guardDecision(
        { url: request.url(), method: request.method() },
        { origin, blockedPathPrefixes: options.blockedPathPrefixes, taskMode: browser.#taskMode },
      );
      if (decision !== "allow" && !browser.#counted.has(request)) {
        browser.#counted.add(request);
        recordGuard(browser.stats, decision, request.url());
      }
      const answered = (decision === "allow" ? route.continue() : route.abort("blockedbyclient")).catch(() => undefined);
      browser.#pending.add(answered);
      void answered.finally(() => browser.#pending.delete(answered));
      return answered;
    });
    // A request the browser blocked by itself never reaches the handler above, so count it here.
    context.on("requestfailed", (request) => {
      if (browser.#counted.has(request)) return;
      const decision = guardDecision(
        { url: request.url(), method: request.method() },
        { origin, blockedPathPrefixes: options.blockedPathPrefixes, taskMode: false },
      );
      if (decision === "blocked_path") {
        browser.#counted.add(request);
        recordGuard(browser.stats, decision, request.url());
      }
    });
    return browser;
  }

  async #open(): Promise<Page> {
    const page = await this.#context.newPage();
    const cdp = await this.#context.newCDPSession(page);
    await cdp.send("Network.enable");
    // Enforced by the browser's own network stack, so it holds even if this process is slow or the tab closes.
    await cdp.send("Network.setBlockedURLs", {
      urls: this.#blocked.flatMap((prefix) => [`${this.#origin}${prefix}`, `${this.#origin}${prefix}/*`, `${this.#origin}${prefix}?*`]),
    });
    return page;
  }

  /** Stops whatever the tab is doing, waits for every outstanding decision, and only then closes it. */
  async #retire(page: Page): Promise<void> {
    await page.goto("about:blank").catch(() => undefined);
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    await page.close().catch(() => undefined);
  }

  #withPage<T>(taskMode: boolean, fn: (page: Page) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const page = await this.#open();
      this.#taskMode = taskMode;
      try {
        return await fn(page);
      } finally {
        await this.#retire(page);
        this.#taskMode = false;
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
