import { mkdirSync } from "node:fs";
import { BrowserWindow, session, type Session } from "electron";
import {
  guardDecision,
  recordGuard,
  serialQueue,
  type GuardStats,
  type PageRead,
  type SiteBrowser,
  type SiteBrowserOptions,
} from "../../worker/src/site-browser.ts";

const LOAD_TIMEOUT_MS = 15_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * The isolated profile as a browser session built into the desktop app. It
 * has its own cookies and storage, kept apart from the dashboard window and
 * from every browser the host uses day to day.
 *
 * Every request the session makes is judged before it is sent, by a handler
 * that answers on the spot, so nothing can slip out while a decision is
 * pending. Permissions, downloads and pop-ups are refused outright.
 */
export class ElectronSiteBrowser implements SiteBrowser {
  readonly #session: Session;
  readonly #serial = serialQueue();
  #taskMode = false;
  readonly stats: GuardStats = { offOrigin: 0, blockedPath: 0, blockedMethod: 0, blockedPaths: [] };

  private constructor(ses: Session) {
    this.#session = ses;
  }

  static async launch(options: SiteBrowserOptions): Promise<ElectronSiteBrowser> {
    mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
    const ses = session.fromPath(options.profileDir);
    const browser = new ElectronSiteBrowser(ses);
    const origin = new URL(options.allowedOrigin).origin;

    ses.webRequest.onBeforeRequest((details, respond) => {
      const decision = guardDecision(
        { url: details.url, method: details.method },
        { origin, blockedPathPrefixes: options.blockedPathPrefixes, taskMode: browser.#taskMode },
      );
      if (decision === "allow") return respond({});
      recordGuard(browser.stats, decision, details.url);
      respond({ cancel: true });
    });
    ses.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (event) => event.preventDefault());
    return browser;
  }

  #window(visible: boolean): BrowserWindow {
    const window = new BrowserWindow({
      show: visible,
      width: visible ? 520 : 1280,
      height: visible ? 760 : 900,
      autoHideMenuBar: true,
      title: "Sign in to the rented account",
      webPreferences: {
        session: this.#session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    return window;
  }

  async #load(window: BrowserWindow, url: string): Promise<number> {
    let status = 0;
    window.webContents.on("did-navigate", (_event, _url, code) => {
      status = code;
    });
    await Promise.race([
      // A page that answers with an error status, or redirects, still counts as loaded; the caller reads the outcome.
      window.loadURL(url).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS)),
    ]);
    return status;
  }

  #withWindow<T>(taskMode: boolean, fn: (window: BrowserWindow) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const window = this.#window(false);
      this.#taskMode = taskMode;
      try {
        return await fn(window);
      } finally {
        if (!window.isDestroyed()) window.destroy();
        this.#taskMode = false;
      }
    });
  }

  read(request: { url: string; container: string; selectors: Readonly<Record<string, string>> }): Promise<PageRead> {
    return this.#withWindow(true, async (window) => {
      const status = await this.#load(window, request.url);
      // Runs in a world of its own, so the page's scripts cannot interfere with how the fields are read.
      const code = `((container, selectors) => {
        const cards = document.querySelectorAll(container);
        const values = {};
        if (cards.length === 1) {
          for (const [name, selector] of Object.entries(selectors)) {
            const nodes = cards[0].querySelectorAll(selector);
            if (nodes.length === 1) values[name] = String(nodes[0].textContent || "");
          }
        }
        return { matches: cards.length, values };
      })(${JSON.stringify(request.container)}, ${JSON.stringify(request.selectors)})`;
      const found = (await window.webContents.executeJavaScriptInIsolatedWorld(4242, [{ code }]).catch(() => null)) as
        | { matches: number; values: Record<string, string> }
        | null;
      return { finalUrl: window.webContents.getURL(), status, matches: found?.matches ?? 0, values: found?.values ?? {} };
    });
  }

  visit(url: string): Promise<{ finalUrl: string; status: number }> {
    return this.#withWindow(false, async (window) => {
      const status = await this.#load(window, url);
      return { finalUrl: window.webContents.getURL(), status };
    });
  }

  /**
   * Shows the site's own sign-in page in a window of the isolated profile.
   * The host types their details into the site, not into this app. The window
   * closes by itself once the site moves on from the sign-in page.
   */
  openSignIn(url: string): Promise<void> {
    return this.#serial(async () => {
      const startPath = new URL(url).pathname;
      const window = this.#window(true);
      this.#taskMode = false;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          if (!window.isDestroyed()) window.destroy();
          resolve();
        };
        const timer = setTimeout(finish, SIGN_IN_TIMEOUT_MS);
        window.on("closed", finish);
        window.webContents.on("did-navigate", (_event, navigated) => {
          try {
            if (new URL(navigated).pathname !== startPath) setTimeout(finish, 300);
          } catch {
            /* not a URL we can read: keep waiting */
          }
        });
        void window.loadURL(url).catch(() => undefined);
      });
    });
  }

  async close(): Promise<void> {
    await this.#session.flushStorageData?.();
  }
}
