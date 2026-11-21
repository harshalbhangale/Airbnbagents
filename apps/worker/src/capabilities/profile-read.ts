import { ExecutorError, type Executor } from "@agentbnb/privacy";
import type { IsolatedBrowser } from "../browser.ts";

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
export function profileReadExecutor(browser: IsolatedBrowser, siteOrigin: string): Executor {
  const origin = new URL(siteOrigin).origin;
  return ({ input, fields }) => {
    const handle = input.handle;
    // Already validated by the privacy layer; checked again because this string goes into a URL.
    if (typeof handle !== "string" || !HANDLE.test(handle)) throw new Error("invalid handle");
    const target = `${origin}/in/${handle}`;

    return browser.withTaskPage(async (page) => {
      const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const landed = new URL(page.url());
      if (landed.origin !== origin) throw new Error("left the allowed site");
      if (landed.pathname === "/login") throw new ExecutorError("not_signed_in");
      if (!response || response.status() === 404) throw new ExecutorError("not_found");
      if (!response.ok() || landed.pathname !== `/in/${handle}`) throw new Error("unexpected page");

      const card = page.locator(`article[data-profile="${handle}"]`);
      if ((await card.count()) !== 1) throw new ExecutorError("not_found");

      const result: Record<string, string> = {};
      for (const field of fields) {
        const selector = SELECTORS[field];
        if (!selector) continue;
        const node = card.locator(selector);
        if ((await node.count()) !== 1) continue;
        result[field] = ((await node.textContent()) ?? "").replace(/\s+/g, " ").trim();
      }
      return result;
    });
  };
}
