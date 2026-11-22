import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_ACCOUNT, startDemoSite, type DemoSite } from "@agentbnb/demo-site";
import { AgentClient, type WorkerListing } from "@agentbnb/sdk";
import { HostApp } from "@agentbnb/worker";
import { CardProcessorError, DodoProcessor, Treasury, startMarketplace, type Marketplace } from "../src/index.ts";
import { startFakeDodo, type FakeDodo } from "./fake-dodo.ts";
import { startFakeFacilitator, type FakeFacilitator } from "./fake-facilitator.ts";

const PAYOUT = "0x1111111111111111111111111111111111111111";
const RETURN = "https://market.example/console";

let dodo: FakeDodo;
let processor: DodoProcessor;

beforeAll(async () => {
  dodo = await startFakeDodo();
  processor = new DodoProcessor({ apiKey: dodo.apiKey, productId: dodo.productId, apiBase: dodo.apiBase });
});
afterAll(() => dodo?.close());

const open = (amountCents = 500, accountId = "acct_one") => processor.createCheckout({ accountId, amountCents, returnUrl: RETURN });

describe("Dodo Payments checkout", () => {
  it("opens a checkout for the pay-what-you-want product at the chosen amount", async () => {
    const checkout = await open(1500, "acct_abc");
    expect(checkout.id).toMatch(/^cks_/);
    expect(checkout.url).toBe(`${dodo.apiBase}/session/${checkout.id}`);
    expect(dodo.created.at(-1)).toEqual({
      product_cart: [{ product_id: dodo.productId, quantity: 1, amount: 1500 }],
      billing_currency: "USD",
      return_url: `${RETURN}?topup=return`,
      metadata: { agentbnb_account: "acct_abc", agentbnb_amount_cents: 1500 },
    });
  });

  it("reports a checkout as pending until the customer has paid", async () => {
    const { id } = await open();
    expect(await processor.getCheckout(id)).toEqual({ paid: false, amountCents: 0, accountId: null });
  });

  it("reports a successful payment with the amount asked for and the account it belongs to", async () => {
    const { id } = await open(2500, "acct_two");
    dodo.pay(id);
    expect(await processor.getCheckout(id)).toEqual({ paid: true, amountCents: 2500, accountId: "acct_two" });
  });

  it("does not count tax added on top as credit", async () => {
    const { id } = await open(500);
    dodo.pay(id, { tax: 90 });
    expect((await processor.getCheckout(id)).amountCents).toBe(500);
  });

  it.each(["processing", "failed", "cancelled", "requires_customer_action", "requires_payment_method"])("does not credit a payment that is %s", async (status) => {
    const { id } = await open(500, "acct_three");
    dodo.pay(id, { status });
    expect(await processor.getCheckout(id)).toEqual({ paid: false, amountCents: 0, accountId: "acct_three" });
  });

  it("never credits more than was paid in dollars", async () => {
    const { id } = await open(2500);
    dodo.pay(id, { totalAmount: 700 });
    expect((await processor.getCheckout(id)).amountCents).toBe(700);
    const zero = await open(2500);
    dodo.pay(zero.id, { totalAmount: 0 });
    expect(await processor.getCheckout(zero.id)).toMatchObject({ paid: false, amountCents: 0 });
  });

  it("credits the amount asked for when the customer paid in another currency", async () => {
    const { id } = await open(500);
    dodo.pay(id, { currency: "INR", totalAmount: 42_000 });
    expect(await processor.getCheckout(id)).toMatchObject({ paid: true, amountCents: 500 });
  });

  it("ignores a payment that says it belongs to a different checkout", async () => {
    const { id } = await open(500);
    dodo.pay(id, { checkoutSessionId: "cks_someoneelse" });
    expect(await processor.getCheckout(id)).toEqual({ paid: false, amountCents: 0, accountId: null });
  });

  it("does not credit a payment whose details were not set by us", async () => {
    const noAmount = await open(500);
    dodo.pay(noAmount.id, { metadata: { agentbnb_account: "acct_one" } });
    expect((await processor.getCheckout(noAmount.id)).paid).toBe(false);
    const badAmount = await open(500);
    dodo.pay(badAmount.id, { metadata: { agentbnb_account: "acct_one", agentbnb_amount_cents: "lots" } });
    expect((await processor.getCheckout(badAmount.id)).paid).toBe(false);
  });

  it("fails clearly on a bad reference, a wrong key or a wrong product", async () => {
    await expect(processor.getCheckout("cs_test_stripe_style")).rejects.toBeInstanceOf(CardProcessorError);
    await expect(processor.getCheckout("cks_doesnotexist000")).rejects.toThrow(/NOT_FOUND/);
    const wrongKey = new DodoProcessor({ apiKey: "dodo_test_wrong", productId: dodo.productId, apiBase: dodo.apiBase });
    await expect(wrongKey.createCheckout({ accountId: "a", amountCents: 500, returnUrl: RETURN })).rejects.toThrow(/UNAUTHORIZED/);
    const wrongProduct = new DodoProcessor({ apiKey: dodo.apiKey, productId: "pdt_missing", apiBase: dodo.apiBase });
    await expect(wrongProduct.createCheckout({ accountId: "a", amountCents: 500, returnUrl: RETURN })).rejects.toThrow(/PRODUCT_NOT_FOUND/);
  });

  it("talks to the test host with a test key and the live host with a live key", async () => {
    const seen: string[] = [];
    const spy = (async (url: unknown) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ session_id: "cks_abcdef123", checkout_url: "https://checkout.example/x" }), { status: 200 });
    }) as typeof fetch;
    await new DodoProcessor({ apiKey: "dodo_test_abc", productId: "pdt_1", fetch: spy }).createCheckout({ accountId: "a", amountCents: 500, returnUrl: RETURN });
    await new DodoProcessor({ apiKey: "dodo_live_abc", productId: "pdt_1", fetch: spy }).createCheckout({ accountId: "a", amountCents: 500, returnUrl: RETURN });
    expect(seen).toEqual(["https://test.dodopayments.com/checkouts", "https://live.dodopayments.com/checkouts"]);
  });
});

describe("a marketplace taking cards through Dodo Payments", () => {
  let site: DemoSite;
  let chain: FakeFacilitator;
  let market: Marketplace;
  let host: HostApp;
  let dataDir: string;
  let listing: WorkerListing;
  const treasury = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    site = await startDemoSite();
    chain = await startFakeFacilitator();
    dataDir = mkdtempSync(join(tmpdir(), "agentbnb-dodo-"));
    market = await startMarketplace({ facilitatorUrl: chain.url, network: chain.network, card: { processor, treasury: new Treasury(treasury) } });
    chain.fund(treasury.address, 5_000_000);
    host = await HostApp.start({ dataDir, siteOrigin: site.origin, marketplaceUrl: market.hostUrl });
    await host.signIn(HOST_ACCOUNT.email, HOST_ACCOUNT.password);
    host.setPayoutAddress(PAYOUT);
    await host.whenConnected();
    listing = (await new AgentClient({ baseUrl: market.url }).listWorkers())[0]!;
  });

  afterAll(async () => {
    await host?.close();
    await market?.close();
    await chain?.close();
    await site?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("turns a card payment into credit and credit into a paid task", async () => {
    const { apiKey } = await AgentClient.createAccount(market.url);
    const client = new AgentClient({ baseUrl: market.url, apiKey });
    const { topUpId, checkoutUrl } = await client.createTopUp(5);
    expect(checkoutUrl).toBe(`${dodo.apiBase}/session/${topUpId}`);
    expect(dodo.created.at(-1)?.return_url).toBe(`${market.url}/console?topup=return`);
    expect(await client.confirmTopUp(topUpId)).toEqual({ status: "pending", creditMicroUsd: 0 });

    dodo.pay(topUpId, { tax: 40 });
    expect(await client.confirmTopUp(topUpId)).toEqual({ status: "paid", creditMicroUsd: 5_000_000 });
    expect(await client.confirmTopUp(topUpId)).toEqual({ status: "paid", creditMicroUsd: 5_000_000 });

    const outcome = await client.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });
    expect(outcome.payment).toMatchObject({ paidWith: "credit", amount: 20_000, creditRemainingMicroUsd: 4_980_000 });
    expect(chain.balanceOf(PAYOUT)).toBe(20_000);
  });

  it("will not let one account claim another's payment, before or after it is paid", async () => {
    const payer = await AgentClient.createAccount(market.url);
    const thief = await AgentClient.createAccount(market.url);
    const payerClient = new AgentClient({ baseUrl: market.url, apiKey: payer.apiKey });
    const thiefClient = new AgentClient({ baseUrl: market.url, apiKey: thief.apiKey });
    const { topUpId } = await payerClient.createTopUp(25);

    expect(await thiefClient.confirmTopUp(topUpId)).toEqual({ status: "pending", creditMicroUsd: 0 });
    dodo.pay(topUpId);
    await expect(thiefClient.confirmTopUp(topUpId)).rejects.toMatchObject({ status: 404 });
    expect((await thiefClient.getAccount()).creditMicroUsd).toBe(0);
    expect((await payerClient.confirmTopUp(topUpId)).creditMicroUsd).toBe(25_000_000);
  });

  it("lets a person pay in the console even though Dodo does not hand the checkout reference back", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${market.url}/console`);
      await page.click("#create-button");
      await page.waitForSelector("#new-key:not([hidden])");
      await page.click("#saved-key-button");
      await expect.poll(() => page.textContent("#credit")).toBe("$0.00");

      await Promise.all([page.waitForURL(`${dodo.apiBase}/session/**`), page.click("#top-up-buttons button")]);
      const sessionId = (await page.textContent("#session")) ?? "";
      const paymentId = dodo.pay(sessionId);

      // Dodo returns the customer with its own details in the address, and no checkout reference.
      await page.goto(`${market.url}/console?topup=return&payment_id=${paymentId}&status=succeeded`);
      await expect.poll(() => page.textContent("#credit")).toBe("$5.00");
      expect(new URL(page.url()).search).toBe("");

      // Reloading afterwards does not credit it again.
      await page.reload();
      await expect.poll(() => page.textContent("#credit")).toBe("$5.00");
    } finally {
      await browser.close();
    }
  });
});
