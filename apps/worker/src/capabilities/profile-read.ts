import { ExecutorError, type Executor } from "@agentbnb/privacy";
import type { SiteBrowser } from "../site-browser.ts";

/** One fixed selector per field. Agents cannot supply their own. */
const SELECTORS: Readonly<Record<string, string>> = {
  name: '[data-field="name"]',
  headline: '[data-field="headline"]',
  company: '[data-field="company"]',
  about: '[data-field="about"]',
  location: '[data-field="location"]',
  email: '[data-field="email"]',
};

const HANDLE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * profile.read for the Meshwork demo site. Opens exactly one URL built from a
 * validated handle and reads only the fields it was told it may read. It never
 * returns page HTML, screenshots, cookies or anything outside the profile card.
 */
export function profileReadExecutor(browser: SiteBrowser, siteOrigin: string): Executor {
  const origin = new URL(siteOrigin).origin;
  return async ({ input, fields }) => {
    const handle = input.handle;
    // Already validated by the privacy layer; checked again because this string goes into a URL.
    if (typeof handle !== "string" || !HANDLE.test(handle)) throw new Error("invalid handle");

    const selectors: Record<string, string> = {};
    for (const field of fields) {
      const selector = SELECTORS[field];
      if (selector) selectors[field] = selector;
    }
    const page = await browser.read({ url: `${origin}/in/${handle}`, container: `article[data-profile="${handle}"]`, selectors });

    const landed = new URL(page.finalUrl);
    if (landed.origin !== origin) throw new Error("left the allowed site");
    if (landed.pathname === "/login") throw new ExecutorError("not_signed_in");
    if (page.status === 404) throw new ExecutorError("not_found");
    if (page.status < 200 || page.status >= 300 || landed.pathname !== `/in/${handle}`) throw new Error("unexpected page");
    if (page.matches !== 1) throw new ExecutorError("not_found");

    const result: Record<string, string> = {};
    for (const [field, text] of Object.entries(page.values)) result[field] = text.replace(/\s+/g, " ").trim();
    return result;
  };
}
