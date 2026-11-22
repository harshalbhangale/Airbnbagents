/**
 * What the worker needs from a browser, and nothing more. Two things
 * implement it: a Playwright-driven Chromium (used on the command line and in
 * tests) and the desktop app's own built-in browser.
 */
export interface GuardStats {
  offOrigin: number;
  blockedPath: number;
  blockedMethod: number;
  /** Paths (never query strings or bodies) of refused same-site requests. */
  blockedPaths: string[];
}

export interface SiteBrowserOptions {
  /** A browser profile used for rented tasks only. The host's everyday browser is never touched. */
  profileDir: string;
  /** The one site this profile may talk to. Every other origin is refused. */
  allowedOrigin: string;
  /** Path prefixes that are refused even on the allowed site. */
  blockedPathPrefixes: readonly string[];
  headless?: boolean;
}

export interface PageRead {
  /** Where the browser ended up after any redirects. */
  finalUrl: string;
  /** HTTP status of the page itself. 0 if it could not be loaded. */
  status: number;
  /** How many elements matched the container selector. */
  matches: number;
  /** Text of each requested selector that matched exactly once inside the container. */
  values: Record<string, string>;
}

export interface SiteBrowser {
  readonly stats: GuardStats;
  /**
   * A rented task: load one URL read-only in a fresh tab and read the text of
   * fixed selectors. Never returns HTML, screenshots or anything else.
   */
  read(request: { url: string; container: string; selectors: Readonly<Record<string, string>> }): Promise<PageRead>;
  /** A host setup step: load a URL and report where it landed. */
  visit(url: string): Promise<{ finalUrl: string; status: number }>;
  /** A host setup step: fill and submit a form on the site. Drivers with a visible sign-in window may omit this. */
  submitForm?(request: { url: string; fields: Readonly<Record<string, string>>; submit: string }): Promise<{ finalUrl: string }>;
  /** Opens a visible window for the host to sign in themselves. Resolves when they are done or close it. */
  openSignIn?(url: string): Promise<void>;
  close(): Promise<void>;
}

export type GuardDecision = "allow" | "off_origin" | "blocked_path" | "blocked_method";

/**
 * The network rule both browsers enforce on every request the isolated
 * profile tries to make. It is the backstop behind the fixed task code: even
 * if a page tries to load the inbox by itself, the request never leaves.
 */
export function guardDecision(
  request: { url: string; method: string },
  rules: { origin: string; blockedPathPrefixes: readonly string[]; taskMode: boolean },
): GuardDecision {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "off_origin";
  }
  // A WebSocket to the same host is still the same site; anything else on another scheme is not.
  const scheme = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  if (`${scheme}//${url.host}` !== rules.origin) return "off_origin";
  const path = url.pathname;
  if (rules.blockedPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return "blocked_path";
  // Rented tasks are read-only: nothing is submitted, posted or changed on the host's account.
  if (rules.taskMode && (request.method.toUpperCase() !== "GET" || url.protocol.startsWith("ws"))) return "blocked_method";
  return "allow";
}

export function recordGuard(stats: GuardStats, decision: GuardDecision, url: string): void {
  if (decision === "off_origin") stats.offOrigin++;
  else if (decision === "blocked_method") stats.blockedMethod++;
  else if (decision === "blocked_path") {
    stats.blockedPath++;
    try {
      if (stats.blockedPaths.length < 500) stats.blockedPaths.push(new URL(url).pathname);
    } catch {
      /* not a URL: nothing to record */
    }
  }
}

/** Runs async jobs one at a time, in order. */
export function serialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}
