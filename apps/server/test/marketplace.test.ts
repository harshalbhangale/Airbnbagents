import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_ACCOUNT, MESSAGES, startDemoSite, type DemoSite } from "@agentbnb/demo-site";
import { canonicalJson, sealRequest, sha256Hex } from "@agentbnb/protocol";
import { AgentClient, MarketplaceError, PaymentRequiredError, type WorkerListing } from "@agentbnb/sdk";
import { HostWorker, connectToMarketplace, type MarketplaceLink } from "@agentbnb/worker";
import { startMarketplace, type Marketplace } from "../src/index.ts";
import { startFakeFacilitator, type FakeFacilitator } from "./fake-facilitator.ts";

const PAYOUT = "0x1111111111111111111111111111111111111111";
const PRICE = 20_000; // $0.02

let site: DemoSite;
let chain: FakeFacilitator;
let market: Marketplace;
let worker: HostWorker;
let link: MarketplaceLink;
let dataDir: string;
let listing: WorkerListing;

const wallet = privateKeyToAccount(generatePrivateKey());
let agent: AgentClient;

beforeAll(async () => {
  site = await startDemoSite();
  chain = await startFakeFacilitator();
  market = await startMarketplace({ facilitatorUrl: chain.url, network: chain.network });
  dataDir = mkdtempSync(join(tmpdir(), "agentbnb-market-"));
  worker = await HostWorker.start({ dataDir, siteOrigin: site.origin });
  await worker.signIn(HOST_ACCOUNT.email, HOST_ACCOUNT.password);
  link = connectToMarketplace(worker, { url: market.hostUrl, payoutAddress: PAYOUT });
  await link.ready;
  agent = new AgentClient({ baseUrl: market.url, wallet });
  chain.fund(wallet.address, 1_000_000);
  listing = (await agent.listWorkers())[0]!;
});

afterAll(async () => {
  link?.close();
  await worker?.close();
  await market?.close();
  await chain?.close();
  await site?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("discovery", () => {
  it("lists the connected worker with its keys, price and payout address", async () => {
    const workers = await agent.listWorkers();
    expect(workers).toHaveLength(1);
    expect(listing).toMatchObject({
      workerKeyId: worker.listing().workerKeyId,
      encryptionKey: worker.listing().encryptionKey,
      signingKey: worker.listing().signingKey,
      payoutAddress: PAYOUT,
      online: true,
      offers: [{ kind: "automation_session", capability: "profile.read", pricePerSession: PRICE }],
    });
    expect(await agent.getWorker(listing.workerKeyId)).toEqual(listing);
    await expect(agent.getWorker("0".repeat(16))).rejects.toBeInstanceOf(MarketplaceError);
  });

  it("picks up a price change when the host re-announces", async () => {
    worker.setOffers([{ kind: "automation_session", capability: "profile.read", pricePerSession: 30_000 }]);
    link.refresh();
    await expect.poll(async () => (await agent.getWorker(listing.workerKeyId)).offers[0]).toMatchObject({ pricePerSession: 30_000 });
    worker.setOffers([{ kind: "automation_session", capability: "profile.read", pricePerSession: PRICE }]);
    link.refresh();
    await expect.poll(async () => (await agent.getWorker(listing.workerKeyId)).offers[0]).toMatchObject({ pricePerSession: PRICE });
  });
});

describe("paid tasks", () => {
  it("asks for payment before doing anything", async () => {
    const before = worker.auditEntries().length;
    const prepared = await sealRequest({
      capability: "profile.read",
      input: { handle: "jordan-lee" },
      workerPublicKey: listing.encryptionKey,
      workerKeyId: listing.workerKeyId,
    });
    const response = await fetch(`${market.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prepared.request),
    });
    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBeTruthy();
    const body = (await response.json()) as { x402Version: number; accepts: { amount: string; payTo: string; network: string; scheme: string }[] };
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: String(PRICE), payTo: PAYOUT });
    expect(worker.auditEntries().length).toBe(before);

    const walletless = new AgentClient({ baseUrl: market.url });
    await expect(walletless.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("runs the task, pays the host directly and returns the approved fields", async () => {
    const outcome = await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });

    expect(outcome.status).toBe("ok");
    expect(outcome.data).toMatchObject({ name: "Jordan Lee", headline: "Software Engineer", company: "Example Labs" });
    expect(outcome.payment).toMatchObject({ network: "eip155:84532", amount: PRICE, payTo: PAYOUT });
    expect(outcome.payment?.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    expect(chain.settlements).toHaveLength(1);
    expect(chain.balanceOf(wallet.address)).toBe(1_000_000 - PRICE);
    expect(chain.balanceOf(PAYOUT)).toBe(PRICE);
  });

  it("shows the payment in the host's earnings", async () => {
    await expect.poll(() => worker.earnings().payments).toBe(1);
    expect(worker.earnings()).toMatchObject({ gross: PRICE, fee: 0, host: PRICE });
  });

  it.each([
    ["a request for private messages", "messages.read", { thread: "latest" }, "denied", "capability_blocked"],
    ["an attempt to steer the browser", "profile.read", { handle: "../messages" }, "rejected", "invalid_input"],
    ["a profile whose output fails the scan", "profile.read", { handle: "sam-okafor" }, "withheld", "output_scan_failed"],
    ["a member that does not exist", "profile.read", { handle: "nobody-here" }, "error", "not_found"],
  ])("does not charge for %s", async (_label, capability, input, status, reason) => {
    const settled = chain.settlements.length;
    const balance = chain.balanceOf(wallet.address);
    const outcome = await agent.runTask({ worker: listing, capability, input });
    expect([outcome.status, outcome.reason]).toEqual([status, reason]);
    expect(outcome.data).toBeNull();
    expect(outcome.payment).toBeNull();
    expect(chain.settlements.length).toBe(settled);
    expect(chain.balanceOf(wallet.address)).toBe(balance);
  });

  it("refuses to pay more than the agent's own limit", async () => {
    const frugal = new AgentClient({ baseUrl: market.url, wallet, maxPriceMicroUsd: 10_000 });
    const verifies = chain.verifyCalls;
    await expect(frugal.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toThrow(/above this client's limit/);
    expect(chain.verifyCalls).toBe(verifies);
  });

  it("refuses to pay anyone but the host in the listing it chose", async () => {
    const swapped = { ...listing, payoutAddress: "0x2222222222222222222222222222222222222222" };
    await expect(agent.runTask({ worker: swapped, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toThrow(/different recipient/);
  });

  it("does no work for a wallet that cannot pay", async () => {
    const broke = new AgentClient({ baseUrl: market.url, wallet: privateKeyToAccount(generatePrivateKey()) });
    const before = worker.auditEntries().length;
    await expect(broke.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toThrow(/insufficient_balance/);
    expect(worker.auditEntries().length).toBe(before);
  });

  it("does not release the result when settlement fails", async () => {
    chain.failNextSettle = true;
    const settled = chain.settlements.length;
    await expect(agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "priya-nair" } })).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(chain.failNextSettle).toBe(false);
    expect(chain.settlements.length).toBe(settled);
    expect(worker.earnings().payments).toBe(1);
  });

  it("will not accept the same signed payment twice", async () => {
    let captured: string | null = null;
    const spy: typeof fetch = async (input, init) => {
      const header = new Headers(init?.headers).get("payment-signature");
      if (header) captured = header;
      return fetch(input, init);
    };
    const first = await new AgentClient({ baseUrl: market.url, wallet, fetch: spy }).runTask({
      worker: listing,
      capability: "profile.read",
      input: { handle: "priya-nair" },
    });
    expect(first.status).toBe("ok");
    expect(captured).toBeTruthy();

    const settled = chain.settlements.length;
    const audited = worker.auditEntries().length;
    const prepared = await sealRequest({
      capability: "profile.read",
      input: { handle: "jordan-lee" },
      workerPublicKey: listing.encryptionKey,
      workerKeyId: listing.workerKeyId,
    });
    const reuse = await fetch(`${market.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": captured! },
      body: JSON.stringify(prepared.request),
    });
    expect(reuse.status).toBe(402);
    expect(chain.settlements.length).toBe(settled);
    expect(worker.auditEntries().length).toBe(audited);
  });
});

describe("what the marketplace can and cannot do", () => {
  it("never holds task content, only routing, outcome and payment", async () => {
    const records = JSON.stringify(market.tasks());
    expect(market.tasks().length).toBeGreaterThan(5);
    for (const secret of ["Jordan", "jordan-lee", "priya", "Example Labs", ...MESSAGES.map((m) => m.body)]) {
      expect(records).not.toContain(secret);
    }
    expect(market.tasks().filter((t) => t.transaction).length).toBe(chain.settlements.length);
  });

  it("returns a clear error for a worker that is not connected", async () => {
    const ghost = { ...listing, workerKeyId: "f".repeat(16) };
    await expect(agent.runTask({ worker: ghost, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toMatchObject({
      status: 404,
      code: "worker_not_found",
    });
  });

  it("rejects malformed task submissions", async () => {
    for (const body of ["{", JSON.stringify({ capability: "profile.read" }), JSON.stringify([1, 2, 3])]) {
      const response = await fetch(`${market.url}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(400);
    }
  });

  it("refuses a host that cannot prove it holds the key in its listing", async () => {
    const real = worker.listing();
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(market.hostUrl);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "challenge") {
          // Replays the real worker's public listing, signed for a different nonce.
          const forged = worker.signMarketplaceAuth("A".repeat(32), sha256Hex(canonicalJson({ listing: real, payoutAddress: PAYOUT })));
          socket.send(JSON.stringify({ type: "hello", listing: real, payoutAddress: "0x3333333333333333333333333333333333333333", signature: forged }));
        } else resolve(message.type);
      });
      socket.addEventListener("close", () => resolve("closed"));
    });
    expect(outcome).toBe("refused");
    expect((await agent.getWorker(listing.workerKeyId)).payoutAddress).toBe(PAYOUT);
  });

  it("does not pay out on a result it cannot verify", async () => {
    // A dishonest host: valid identity, but answers every task with a made-up "ok".
    const rogueDir = mkdtempSync(join(tmpdir(), "agentbnb-rogue-"));
    const rogue = await HostWorker.start({ dataDir: rogueDir, siteOrigin: site.origin });
    try {
      const rogueListing = rogue.listing();
      const socket = new WebSocket(market.hostUrl);
      await new Promise<void>((resolve) => {
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (message.type === "challenge") {
            const signature = rogue.signMarketplaceAuth(message.nonce, sha256Hex(canonicalJson({ listing: rogueListing, payoutAddress: PAYOUT })));
            socket.send(JSON.stringify({ type: "hello", listing: rogueListing, payoutAddress: PAYOUT, signature }));
          } else if (message.type === "welcome") resolve();
          else if (message.type === "task") {
            socket.send(
              JSON.stringify({
                type: "result",
                id: message.id,
                result: { v: 1, taskId: message.request.taskId, capability: "profile.read", status: "ok", reason: null, enc: null, ciphertext: null, receipt: {}, signature: "AAAA" },
              }),
            );
          }
        });
      });
      const settled = chain.settlements.length;
      const target = (await agent.listWorkers()).find((w) => w.workerKeyId === rogueListing.workerKeyId)!;
      await expect(agent.runTask({ worker: target, capability: "profile.read", input: { handle: "jordan-lee" } })).rejects.toMatchObject({
        status: 502,
        code: "worker_result_unverified",
      });
      expect(chain.settlements.length).toBe(settled);
      socket.close();
    } finally {
      await rogue.close();
      rmSync(rogueDir, { recursive: true, force: true });
    }
  });
});
