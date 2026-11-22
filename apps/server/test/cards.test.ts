import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_ACCOUNT, startDemoSite, type DemoSite } from "@agentbnb/demo-site";
import { AgentClient, MarketplaceError, PaymentRequiredError, type WorkerListing } from "@agentbnb/sdk";
import { HostApp } from "@agentbnb/worker";
import { AccountStore, StripeProcessor, Treasury, startMarketplace, type Marketplace } from "../src/index.ts";
import { startFakeFacilitator, type FakeFacilitator } from "./fake-facilitator.ts";
import { startFakeStripe, type FakeStripe } from "./fake-stripe.ts";

const PAYOUT = "0x1111111111111111111111111111111111111111";
const PRICE = 20_000;

let site: DemoSite;
let chain: FakeFacilitator;
let stripe: FakeStripe;
let market: Marketplace;
let host: HostApp;
let dataDir: string;
let listing: WorkerListing;
let accountsFile: string;
const treasuryWallet = privateKeyToAccount(generatePrivateKey());

async function renter() {
  const { accountId, apiKey } = await AgentClient.createAccount(market.url);
  return { accountId, apiKey, client: new AgentClient({ baseUrl: market.url, apiKey }) };
}

/** A renter who has already paid for some credit by card. */
async function fundedRenter(amountUsd = 5) {
  const r = await renter();
  const { topUpId } = await r.client.createTopUp(amountUsd);
  stripe.pay(topUpId);
  await r.client.confirmTopUp(topUpId);
  return r;
}

beforeAll(async () => {
  site = await startDemoSite();
  chain = await startFakeFacilitator();
  stripe = await startFakeStripe();
  dataDir = mkdtempSync(join(tmpdir(), "agentbnb-cards-"));
  accountsFile = join(dataDir, "accounts.jsonl");
  market = await startMarketplace({
    facilitatorUrl: chain.url,
    network: chain.network,
    accountsFile,
    card: { processor: new StripeProcessor({ secretKey: stripe.secretKey, apiBase: stripe.apiBase }), treasury: new Treasury(treasuryWallet) },
  });
  chain.fund(treasuryWallet.address, 10_000_000);
  host = await HostApp.start({ dataDir: join(dataDir, "host"), siteOrigin: site.origin, marketplaceUrl: market.hostUrl });
  await host.signIn(HOST_ACCOUNT.email, HOST_ACCOUNT.password);
  host.setPayoutAddress(PAYOUT);
  await host.whenConnected();
  listing = (await new AgentClient({ baseUrl: market.url }).listWorkers())[0]!;
});

afterAll(async () => {
  await host?.close();
  await market?.close();
  await stripe?.close();
  await chain?.close();
  await site?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("renter accounts", () => {
  it("creates an account with a key that works and starts with no credit", async () => {
    const { accountId, client } = await renter();
    expect(await client.getAccount()).toMatchObject({ accountId, creditMicroUsd: 0, cardPayments: true, history: [] });
  });

  it("rejects a wrong or malformed key", async () => {
    for (const apiKey of ["abnb_" + "A".repeat(43), "not-a-key", ""]) {
      const response = await fetch(`${market.url}/account`, { headers: { authorization: `Bearer ${apiKey}` } });
      expect(response.status).toBe(401);
    }
    expect((await fetch(`${market.url}/account`)).status).toBe(401);
  });

  it("never writes an API key to disk", async () => {
    const { apiKey } = await renter();
    expect(readFileSync(accountsFile, "utf8")).not.toContain(apiKey);
  });
});

describe("buying credit by card", () => {
  it("opens a checkout on the card processor for the right amount and account", async () => {
    const { accountId, client } = await renter();
    const { topUpId, checkoutUrl } = await client.createTopUp(5);
    expect(checkoutUrl).toBe(`${stripe.apiBase}/pay/${topUpId}`);
    expect(stripe.created.at(-1)).toMatchObject({
      mode: "payment",
      client_reference_id: accountId,
      "metadata[agentbnb_account]": accountId,
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "500",
      "line_items[0][quantity]": "1",
      success_url: `${market.url}/console?topup={CHECKOUT_SESSION_ID}`,
      cancel_url: `${market.url}/console`,
    });
  });

  it("adds credit only once the card payment has gone through, and only once", async () => {
    const { client } = await renter();
    const { topUpId } = await client.createTopUp(5);
    expect(await client.confirmTopUp(topUpId)).toEqual({ status: "pending", creditMicroUsd: 0 });

    stripe.pay(topUpId);
    expect(await client.confirmTopUp(topUpId)).toEqual({ status: "paid", creditMicroUsd: 5_000_000 });
    expect(await client.confirmTopUp(topUpId)).toEqual({ status: "paid", creditMicroUsd: 5_000_000 });
    expect((await client.getAccount()).history).toMatchObject([{ kind: "topup", amount: 5_000_000 }]);
  });

  it("credits what was actually charged, and nothing for a payment in another currency", async () => {
    const short = await renter();
    const a = await short.client.createTopUp(10);
    stripe.pay(a.topUpId, { amountTotal: 700 });
    expect((await short.client.confirmTopUp(a.topUpId)).creditMicroUsd).toBe(7_000_000);

    const foreign = await renter();
    const b = await foreign.client.createTopUp(10);
    stripe.pay(b.topUpId, { currency: "eur" });
    expect(await foreign.client.confirmTopUp(b.topUpId)).toEqual({ status: "pending", creditMicroUsd: 0 });
  });

  it("will not let one account claim another account's card payment", async () => {
    const payer = await renter();
    const thief = await renter();
    const { topUpId } = await payer.client.createTopUp(25);
    stripe.pay(topUpId);
    await expect(thief.client.confirmTopUp(topUpId)).rejects.toMatchObject({ status: 404 });
    expect((await thief.client.getAccount()).creditMicroUsd).toBe(0);
    expect((await payer.client.confirmTopUp(topUpId)).creditMicroUsd).toBe(25_000_000);
  });

  it.each([0, 1, 4, 501, 5.5, -5, Number.NaN])("refuses a top-up of %s dollars", async (amountUsd) => {
    const { client } = await renter();
    await expect(client.createTopUp(amountUsd)).rejects.toMatchObject({ status: 400, code: "invalid_amount" });
  });

  it("reports a card processor failure without crediting anything", async () => {
    const broken = await startMarketplace({
      facilitatorUrl: chain.url,
      network: chain.network,
      card: { processor: new StripeProcessor({ secretKey: "sk_test_wrong", apiBase: stripe.apiBase }), treasury: new Treasury(treasuryWallet) },
    });
    try {
      const { apiKey } = await AgentClient.createAccount(broken.url);
      const client = new AgentClient({ baseUrl: broken.url, apiKey });
      await expect(client.createTopUp(5)).rejects.toMatchObject({ status: 502, code: "card_processor_error" });
      expect((await client.getAccount()).creditMicroUsd).toBe(0);
    } finally {
      await broken.close();
    }
  });
});

describe("paying for tasks with card credit", () => {
  it("runs the task, charges the credit, and pays the host in USDC from the treasury", async () => {
    const { client } = await fundedRenter(5);
    const treasuryBefore = chain.balanceOf(treasuryWallet.address);
    const hostBefore = chain.balanceOf(PAYOUT);
    const earnedBefore = host.worker.earnings().payments;

    const outcome = await client.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });

    expect(outcome.status).toBe("ok");
    expect(outcome.data).toMatchObject({ name: "Jordan Lee" });
    expect(outcome.payment).toMatchObject({ amount: PRICE, payTo: PAYOUT, paidWith: "credit", creditRemainingMicroUsd: 5_000_000 - PRICE });
    expect(chain.balanceOf(treasuryWallet.address)).toBe(treasuryBefore - PRICE);
    expect(chain.balanceOf(PAYOUT)).toBe(hostBefore + PRICE);
    await expect.poll(() => host.worker.earnings().payments).toBe(earnedBefore + 1);

    const account = await client.getAccount();
    expect(account.creditMicroUsd).toBe(5_000_000 - PRICE);
    expect(account.history[0]).toMatchObject({ kind: "task", amount: -PRICE, capability: "profile.read", transaction: outcome.payment?.transaction });
    expect(market.tasks().at(-1)).toMatchObject({ status: "ok", paidWith: "credit" });
  });

  it.each([
    ["a request for private messages", "messages.read", { thread: "latest" }, "denied"],
    ["a result held back by the outbound scan", "profile.read", { handle: "sam-okafor" }, "withheld"],
    ["a member that does not exist", "profile.read", { handle: "nobody-here" }, "error"],
  ])("does not charge credit for %s", async (_label, capability, input, status) => {
    const { client } = await fundedRenter(5);
    const treasuryBefore = chain.balanceOf(treasuryWallet.address);
    const outcome = await client.runTask({ worker: listing, capability, input });
    expect(outcome.status).toBe(status);
    expect(outcome.payment).toBeNull();
    expect((await client.getAccount()).creditMicroUsd).toBe(5_000_000);
    expect(chain.balanceOf(treasuryWallet.address)).toBe(treasuryBefore);
  });

  it("does no work for a renter without enough credit", async () => {
    const { client } = await renter();
    const audited = host.worker.auditEntries().length;
    await expect(client.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toThrow(/not enough credit/);
    await expect(client.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(host.worker.auditEntries().length).toBe(audited);
  });

  it("gives the credit back when settlement fails, and releases no result", async () => {
    const { client } = await fundedRenter(5);
    chain.failNextSettle = true;
    await expect(client.runTask({ worker: listing, capability: "profile.read", input: { handle: "priya-nair" } })).rejects.toMatchObject({
      status: 502,
      code: "settlement_failed",
    });
    expect(chain.failNextSettle).toBe(false);
    expect((await client.getAccount()).creditMicroUsd).toBe(5_000_000);
    expect((await client.getAccount()).history.filter((e) => e.kind === "task")).toEqual([]);
  });

  it("keeps the renter's credit intact when the treasury cannot pay", async () => {
    const { client } = await fundedRenter(5);
    const float = chain.balanceOf(treasuryWallet.address);
    chain.fund(treasuryWallet.address, 0);
    const audited = host.worker.auditEntries().length;
    try {
      await expect(client.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toMatchObject({
        status: 503,
        code: "treasury_unavailable",
      });
      expect((await client.getAccount()).creditMicroUsd).toBe(5_000_000);
      expect(host.worker.auditEntries().length).toBe(audited);
    } finally {
      chain.fund(treasuryWallet.address, float);
    }
  });

  it("will not charge more than the price limit the agent set", async () => {
    const { apiKey } = await fundedRenter(5);
    const frugal = new AgentClient({ baseUrl: market.url, apiKey, maxPriceMicroUsd: 10_000 });
    await expect(frugal.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toMatchObject({
      status: 409,
      code: "price_above_limit",
    });
    expect((await frugal.getAccount()).creditMicroUsd).toBe(5_000_000);
  });

  it("cannot spend the same credit twice at once", async () => {
    const { client } = await renter();
    const top = await client.createTopUp(5);
    stripe.pay(top.topUpId, { amountTotal: 3 }); // three cents: enough for exactly one 2-cent task
    await client.confirmTopUp(top.topUpId);

    const attempts = await Promise.allSettled(
      ["jordan-lee", "priya-nair", "casey-host"].map((handle) => client.runTask({ worker: listing, capability: "profile.read", input: { handle } })),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected" && a.reason instanceof PaymentRequiredError)).toHaveLength(2);
    expect((await client.getAccount()).creditMicroUsd).toBe(30_000 - PRICE);
  });

  it("still takes crypto payments from agents with their own wallet", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    chain.fund(wallet.address, 100_000);
    const outcome = await new AgentClient({ baseUrl: market.url, wallet }).runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });
    expect(outcome.payment).toMatchObject({ paidWith: "crypto", amount: PRICE });
    expect(outcome.payment?.creditRemainingMicroUsd).toBeUndefined();
    expect(chain.balanceOf(wallet.address)).toBe(100_000 - PRICE);
  });

  it("says so plainly when card payments are switched off", async () => {
    const plain = await startMarketplace({ facilitatorUrl: chain.url, network: chain.network });
    const second = await HostApp.start({ dataDir: join(dataDir, "host2"), siteOrigin: site.origin, marketplaceUrl: plain.hostUrl });
    try {
      second.setPayoutAddress(PAYOUT);
      await second.whenConnected();
      const { apiKey } = await AgentClient.createAccount(plain.url);
      const client = new AgentClient({ baseUrl: plain.url, apiKey });
      expect((await client.getAccount()).cardPayments).toBe(false);
      await expect(client.createTopUp(5)).rejects.toMatchObject({ status: 503, code: "card_payments_unavailable" });
      const other = (await client.listWorkers())[0]!;
      await expect(client.runTask({ worker: other, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toBeInstanceOf(MarketplaceError);
    } finally {
      await second.close();
      await plain.close();
    }
  });
});

describe("keeping renters' money safe", () => {
  it("restores accounts and credit after a restart", async () => {
    const { accountId, apiKey, client } = await fundedRenter(10);
    await client.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });

    const reopened = new AccountStore(accountsFile);
    expect(reopened.authenticate(apiKey)).toBe(accountId);
    expect(reopened.available(accountId)).toBe(10_000_000 - PRICE);
    expect(reopened.history(accountId).map((e) => e.kind)).toEqual(["task", "topup"]);
    // The same card payment cannot be credited again after a restart either.
    expect(reopened.credit(accountId, 10_000_000, reopened.history(accountId)[1]!.reference)).toBe(false);
  });

  it("holds, charges and releases credit correctly", () => {
    const store = new AccountStore();
    const { accountId } = store.create();
    store.credit(accountId, 50_000, "card:one");
    const first = store.reserve(accountId, 30_000)!;
    expect(store.available(accountId)).toBe(20_000);
    expect(store.reserve(accountId, 30_000)).toBeNull();
    store.release(first);
    store.release(first);
    expect(store.available(accountId)).toBe(50_000);

    const second = store.reserve(accountId, 30_000)!;
    store.commit(second, { taskId: "task-1", capability: "profile.read", transaction: `0x${"ab".repeat(32)}` });
    expect(store.available(accountId)).toBe(20_000);
    expect(() => store.commit(second, { taskId: "task-1", capability: "profile.read", transaction: "0x" })).toThrow();
    expect(store.outstanding()).toBe(20_000);
    expect(store.reserve("acct_missing", 1)).toBeNull();
    expect(() => store.credit(accountId, -5, "card:two")).toThrow(RangeError);
  });
});

describe("the renter console", () => {
  it("lets a person create an account, pay by card and see their credit", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const response = await page.goto(`${market.url}/console`);
      expect(response?.headers()["content-security-policy"]).toContain("default-src 'none'");
      await expect.poll(() => page.textContent("#status-pill")).toBe("1 host online");
      expect(await page.textContent("#worker-rows")).toContain("profile.read");
      expect(await page.textContent("#worker-rows")).toContain("$0.02");

      await page.click("#create-button");
      await page.waitForSelector("#new-key:not([hidden])");
      const apiKey = (await page.textContent("#new-key-value")) ?? "";
      expect(apiKey).toMatch(/^abnb_[A-Za-z0-9_-]{43}$/);
      await page.click("#saved-key-button");
      await expect.poll(() => page.textContent("#credit")).toBe("$0.00");
      expect(await page.textContent("#new-key-value")).toBe("");

      // "Add $5" sends the person to the card processor's own page.
      await Promise.all([page.waitForURL(`${stripe.apiBase}/pay/**`), page.click("#top-up-buttons button")]);
      const topUpId = (await page.textContent("#session")) ?? "";
      stripe.pay(topUpId);

      // The processor sends them back, and the console confirms the payment by itself.
      await page.goto(`${market.url}/console?topup=${topUpId}`);
      await expect.poll(() => page.textContent("#credit")).toBe("$5.00");
      expect(new URL(page.url()).search).toBe("");
      expect(await page.textContent("#history-rows")).toContain("Credit added by card");

      await new AgentClient({ baseUrl: market.url, apiKey }).runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });
      await page.reload();
      await expect.poll(() => page.textContent("#credit")).toBe("$4.98");
      expect(await page.textContent("#history-rows")).toContain("Task: profile.read");
    } finally {
      await browser.close();
    }
  });
});
