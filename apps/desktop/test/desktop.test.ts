import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_ACCOUNT, MESSAGES, startDemoSite, type DemoSite } from "@agentbnb/demo-site";
import { AgentClient, type WorkerListing } from "@agentbnb/sdk";
import { startMarketplace, type Marketplace } from "@agentbnb/server";
import { startFakeFacilitator, type FakeFacilitator } from "../../server/test/fake-facilitator.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAYOUT = "0x1111111111111111111111111111111111111111";
const PRICE = 20_000;

// The app needs a display. On a Linux machine without one, run this under xvfb-run.
const canRun = process.platform !== "linux" || Boolean(process.env.DISPLAY);

let site: DemoSite;
let chain: FakeFacilitator;
let market: Marketplace;
let app: ElectronApplication;
let dashboard: Page;
let userData: string;
let agent: AgentClient;
let listing: WorkerListing;
const wallet = privateKeyToAccount(generatePrivateKey());

describe.skipIf(!canRun)("the desktop app, end to end", () => {
  beforeAll(async () => {
    execFileSync(process.execPath, [join(root, "build.mjs")], { cwd: root, stdio: "inherit" });
    site = await startDemoSite();
    chain = await startFakeFacilitator();
    market = await startMarketplace({ facilitatorUrl: chain.url, network: chain.network });
    chain.fund(wallet.address, 5_000_000);
    agent = new AgentClient({ baseUrl: market.url, wallet });
    userData = mkdtempSync(join(tmpdir(), "agentbnb-desktop-"));

    app = await electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as unknown as string,
      // Running as root (as in a container) needs Chromium's sandbox off; a normal user account does not.
      args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), join(root, "dist/main.mjs")],
      env: {
        ...(process.env as Record<string, string>),
        AGENTBNB_USER_DATA: userData,
        AGENTBNB_MARKETPLACE_URL: market.hostUrl,
        AGENTBNB_SITE_ORIGIN: site.origin,
        AGENTBNB_VERIFY_SETTLEMENTS: "off",
      },
    });
    // The app also opens short-lived hidden windows for the rented account, so pick the dashboard by what it shows.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = [];
      for (const page of app.windows()) {
        if (!page.isClosed() && !page.url().startsWith(site.origin) && (await page.title().catch(() => "")) === "agentbnb host") found.push(page);
      }
      if (found[0]) {
        dashboard = found[0];
        break;
      }
      if (Date.now() > deadline) throw new Error("the dashboard window did not appear");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await market?.close();
    await chain?.close();
    await site?.close();
    if (userData) rmSync(userData, { recursive: true, force: true });
  });

  it("opens on the dashboard, with the rented account signed out", async () => {
    await expect.poll(() => dashboard.textContent("#status-pill"), { timeout: 20_000 }).toBe("Account signed out");
    expect(await dashboard.title()).toBe("agentbnb host");
    // In the desktop app the host signs in through a window of the site itself, never through a form here.
    expect(await dashboard.isVisible("#open-sign-in-button")).toBe(true);
    expect(await dashboard.isVisible("#sign-in-form")).toBe(false);
  });

  it("signs in through the site's own page in a separate window", async () => {
    const [signIn] = await Promise.all([
      app.waitForEvent("window", { predicate: (page) => page.url().includes("/login") || page.url() === "about:blank" || page.url() === "" }),
      dashboard.click("#open-sign-in-button"),
    ]);
    await signIn.waitForSelector('input[name="email"]');
    expect(new URL(signIn.url()).origin).toBe(site.origin);
    await signIn.fill('input[name="email"]', HOST_ACCOUNT.email);
    await signIn.fill('input[name="password"]', HOST_ACCOUNT.password);
    await Promise.all([signIn.waitForEvent("close"), signIn.click('button[type="submit"]')]);
    await expect.poll(() => dashboard.textContent("#status-pill"), { timeout: 20_000 }).toBe("Add a payout address");
  });

  it("goes online once a payout address is set", async () => {
    await dashboard.fill("#payout-input", PAYOUT);
    await dashboard.click('#payout-form button[type="submit"]');
    await expect.poll(() => dashboard.textContent("#status-pill"), { timeout: 20_000 }).toBe("Online");
    await expect.poll(async () => (await agent.listWorkers()).length).toBe(1);
    listing = (await agent.listWorkers())[0]!;
    expect(listing.payoutAddress).toBe(PAYOUT);
  });

  it("serves a paid task for an agent and shows the money", async () => {
    const outcome = await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });
    expect(outcome.status).toBe("ok");
    expect(outcome.data).toEqual({
      name: "Jordan Lee",
      headline: "Software Engineer",
      company: "Example Labs",
      about: "Builds data pipelines and mentors new engineers. Interested in distributed systems and good coffee.",
    });
    expect(outcome.payment).toMatchObject({ amount: PRICE, payTo: PAYOUT });
    expect(chain.balanceOf(PAYOUT)).toBe(PRICE);

    await expect.poll(() => dashboard.textContent("#revenue-all"), { timeout: 10_000 }).toBe("$0.02");
    expect(await dashboard.textContent("#revenue-today")).toBe("$0.02");
    expect(await dashboard.textContent("#payment-rows")).toContain("Awaiting confirmation");
    expect(await dashboard.textContent("#activity-rows")).toContain("Completed");
  });

  it("refuses private messages and attempts to steer the browser, at no charge", async () => {
    const settled = chain.settlements.length;
    const denied = await agent.runTask({ worker: listing, capability: "messages.read", input: { thread: "latest" } });
    expect([denied.status, denied.reason]).toEqual(["denied", "capability_blocked"]);
    const steered = await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "../messages" } });
    expect([steered.status, steered.reason]).toEqual(["rejected", "invalid_input"]);
    const held = await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "sam-okafor" } });
    expect([held.status, held.reason]).toEqual(["withheld", "output_scan_failed"]);
    const missing = await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "nobody-here" } });
    expect([missing.status, missing.reason]).toEqual(["error", "not_found"]);
    expect(chain.settlements.length).toBe(settled);
  });

  it("holds under load: nothing private, posted or third-party leaves the built-in browser", async () => {
    await dashboard.evaluate(() =>
      fetch("/api/state").then((r) => r.json()).then(() => undefined),
    );
    const posts = () => site.requests.filter((r) => r.startsWith("POST /api/analytics")).length;
    const postsBefore = posts();
    const handles = ["jordan-lee", "priya-nair", "casey-host"];
    for (let i = 0; i < 21; i++) {
      const outcome = await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: handles[i % 3], fields: ["name"] } });
      expect(outcome.status).toBe("ok");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(site.requests.filter((r) => r.includes("/messages"))).toEqual([]);
    expect(site.trackerRequests).toEqual([]);
    expect(posts()).toBe(postsBefore);
    expect(await dashboard.textContent("#activity-summary")).toMatch(/refused \d{2,} attempts to load blocked pages and \d{2,} to reach other sites/);

    const shown = (await dashboard.content()) + JSON.stringify(market.tasks());
    for (const secret of ["Jordan Lee", HOST_ACCOUNT.password, ...MESSAGES.map((m) => m.body)]) expect(shown).not.toContain(secret);
  }, 120_000);

  it("applies a rule change from the dashboard to the next task", async () => {
    await dashboard.check('[id="field-profile.read-email"]');
    await expect
      .poll(async () => (await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "priya-nair", fields: ["email"] } })).data, { timeout: 15_000 })
      .toEqual({ email: "priya@northwind.test" });
  });

  it("stops serving the moment the host pauses", async () => {
    await dashboard.click("#pause-button");
    await expect.poll(() => dashboard.textContent("#status-pill")).toBe("Paused");
    const paused = await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });
    expect([paused.status, paused.reason]).toEqual(["denied", "host_paused"]);
    await dashboard.click("#pause-button");
    await expect.poll(() => dashboard.textContent("#status-pill")).toBe("Online");
  });

  it("keeps the dashboard window on the dashboard", async () => {
    const before = dashboard.url();
    await dashboard.evaluate(() => {
      location.href = "https://example.com/";
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(dashboard.url()).toBe(before);
  });
});
