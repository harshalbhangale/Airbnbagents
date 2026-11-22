import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_ACCOUNT, MESSAGES, startDemoSite, type DemoSite } from "@agentbnb/demo-site";
import { sealRequest } from "@agentbnb/protocol";
import { HostApp, startDashboard, type Dashboard } from "../src/index.ts";

let site: DemoSite;
let app: HostApp;
let dashboard: Dashboard;
let dataDir: string;
let browser: Browser;
let page: Page;
let cookie: string;

const field = (name: string) => `[id="field-profile.read-${name}"]`;

async function runTask(capability: string, input: Record<string, unknown>) {
  const listing = app.worker.listing();
  const prepared = await sealRequest({ capability, input, workerPublicKey: listing.encryptionKey, workerKeyId: listing.workerKeyId });
  return (await app.worker.handle(prepared.request)).wire;
}

/** A raw request, so the Host header can be forged the way a rebinding attack would. */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  const { hostname, port } = new URL(dashboard.origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  site = await startDemoSite();
  dataDir = mkdtempSync(join(tmpdir(), "agentbnb-dash-"));
  app = await HostApp.start({ dataDir, siteOrigin: site.origin });
  dashboard = await startDashboard(app);
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  await dashboard?.close();
  await app?.close();
  await site?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("who can reach the dashboard", () => {
  it("turns away anyone without the one-time link", async () => {
    expect((await fetch(`${dashboard.origin}/`)).status).toBe(401);
    expect((await fetch(`${dashboard.origin}/api/state`)).status).toBe(401);
    expect((await fetch(`${dashboard.origin}/?token=${"A".repeat(43)}`, { redirect: "manual" })).status).toBe(403);
  });

  it("lets the host in with the link and keeps a same-site, script-proof cookie", async () => {
    const response = await fetch(dashboard.url, { redirect: "manual" });
    expect(response.status).toBe(303);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    cookie = setCookie.split(";")[0]!;
    const state = await fetch(`${dashboard.origin}/api/state`, { headers: { cookie } });
    expect(state.status).toBe(200);
    expect(state.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("ignores requests that arrive under another site's name", async () => {
    expect(await rawGet("/api/state", { cookie, host: "evil.example" })).toBe(403);
    expect(await rawGet("/api/state", { cookie, host: new URL(dashboard.origin).host })).toBe(200);
  });

  it("refuses changes forged by another page, even with the host's cookie", async () => {
    const forged = (origin: string | undefined) =>
      fetch(`${dashboard.origin}/api/pause`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ paused: true }),
      });
    expect((await forged("https://evil.example")).status).toBe(403);
    expect((await forged(undefined)).status).toBe(403);
    expect(app.worker.paused).toBe(false);

    const formPost = await fetch(`${dashboard.origin}/api/pause`, {
      method: "POST",
      headers: { cookie, origin: dashboard.origin, "content-type": "text/plain" },
      body: JSON.stringify({ paused: true }),
    });
    expect(formPost.status).toBe(415);
    expect(app.worker.paused).toBe(false);
  });
});

describe("the dashboard in a browser", () => {
  it("opens from the link and shows that the account is signed out", async () => {
    await page.goto(dashboard.url);
    expect(new URL(page.url()).search).toBe("");
    await expect.poll(() => page.textContent("#status-pill")).toBe("Account signed out");
    expect(await page.isVisible("#sign-in-form")).toBe(true);
  });

  it("signs the rented account in", async () => {
    await page.fill('#sign-in-form input[name="email"]', HOST_ACCOUNT.email);
    await page.fill('#sign-in-form input[name="password"]', "wrong-password");
    await page.click('#sign-in-form button[type="submit"]');
    await expect.poll(() => page.textContent("#banner")).toContain("not accepted");

    await page.fill('#sign-in-form input[name="password"]', HOST_ACCOUNT.password);
    await page.click('#sign-in-form button[type="submit"]');
    await expect.poll(() => page.textContent("#status-pill")).toBe("Add a payout address");
    expect(await page.isVisible("#sign-in-form")).toBe(false);
    expect(app.signedIn).toBe(true);
  });

  it("saves a payout address and rejects a bad one", async () => {
    const bad = await page.evaluate(() =>
      fetch("/api/payout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "0x123" }) }).then((r) => r.status),
    );
    expect(bad).toBe(400);
    await page.fill("#payout-input", "0x1111111111111111111111111111111111111111");
    await page.click('#payout-form button[type="submit"]');
    await expect.poll(() => app.payoutAddress).toBe("0x1111111111111111111111111111111111111111");
    expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).payoutAddress).toBe("0x1111111111111111111111111111111111111111");
    await expect.poll(() => page.textContent("#status-pill")).toBe("Not listed");
  });

  it("changes which fields agents may receive", async () => {
    expect(await page.isChecked(field("name"))).toBe(true);
    expect(await page.isChecked(field("email"))).toBe(false);
    await page.check(field("email"));
    await expect.poll(() => app.worker.policy.capabilities["profile.read"]?.allowFields).toContain("email");
    await page.uncheck(field("about"));
    await expect.poll(() => app.worker.policy.capabilities["profile.read"]?.allowFields).not.toContain("about");

    const result = await runTask("profile.read", { handle: "jordan-lee" });
    expect(result.status).toBe("ok");
  });

  it("cannot be used to unlock an always-blocked field", async () => {
    expect(await page.isDisabled(field("messages"))).toBe(true);
    expect(await page.isChecked(field("messages"))).toBe(false);
    const before = app.worker.policy;
    const status = await page.evaluate(() =>
      fetch("/api/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: "profile.read", enabled: true, allowFields: ["name", "messages"] }),
      }).then((r) => r.status),
    );
    expect(status).toBe(400);
    expect(app.worker.policy).toEqual(before);
  });

  it("sets the price", async () => {
    await page.fill('[id="price-profile.read"]', "0.05");
    await page.click(".price-form button");
    await expect.poll(() => app.worker.offers[0]).toMatchObject({ pricePerSession: 50_000 });
    const bad = await page.evaluate(() =>
      fetch("/api/price", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: "profile.read", priceUsd: "-1" }) }).then((r) => r.status),
    );
    expect(bad).toBe(400);
    expect(app.worker.offers[0]).toMatchObject({ pricePerSession: 50_000 });
  });

  it("pauses and resumes everything from one button", async () => {
    await page.click("#pause-button");
    await expect.poll(() => app.worker.paused).toBe(true);
    await expect.poll(() => page.textContent("#status-pill")).toBe("Paused");
    expect((await runTask("profile.read", { handle: "jordan-lee" })).reason).toBe("host_paused");
    await page.click("#pause-button");
    await expect.poll(() => app.worker.paused).toBe(false);
  });

  it("shows what happened, in plain words, without showing any content", async () => {
    await runTask("messages.read", { thread: "latest" });
    await expect.poll(() => page.textContent("#activity-rows")).toContain("that category is never rentable");
    const table = (await page.textContent("#activity-rows")) ?? "";
    expect(table).toContain("Completed");
    expect(table).toContain("name, headline, company, email");
    expect(table).toContain("you had paused everything");

    const everything = (await page.content()) + JSON.stringify(await (await fetch(`${dashboard.origin}/api/state`, { headers: { cookie } })).json());
    for (const secret of ["Jordan Lee", "jordan-lee", HOST_ACCOUNT.password, ...MESSAGES.map((m) => m.body)]) {
      expect(everything).not.toContain(secret);
    }
  });
});
