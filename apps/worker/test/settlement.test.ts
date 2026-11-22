import { describe, expect, it } from "vitest";
import { explorerUrl, rpcSettlementVerifier } from "../src/settlement.ts";

const HOST = "0xe8eE56a1289B69AdFABf239D12D8A9f6C0F104Fb";
const TX = `0x${"ab".repeat(32)}`;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const amount = (micro: number) => `0x${micro.toString(16).padStart(64, "0")}`;

const transfer = (overrides: Partial<{ address: string; to: string; value: number; topic: string }> = {}) => ({
  address: overrides.address ?? USDC,
  topics: [overrides.topic ?? TRANSFER, pad("0xf9035E888DCB365bf10CBF8640f995Db370452b3"), pad(overrides.to ?? HOST)],
  data: amount(overrides.value ?? 20_000),
});

/** A verifier wired to a canned chain response instead of the network. */
function verifierFor(result: unknown, options: { httpOk?: boolean; throws?: boolean } = {}) {
  const calls: unknown[] = [];
  const fakeFetch = (async (_url: unknown, init?: { body?: unknown }) => {
    calls.push(JSON.parse(String(init?.body)));
    if (options.throws) throw new Error("network down");
    return { ok: options.httpOk ?? true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  }) as unknown as typeof fetch;
  return { verify: rpcSettlementVerifier(undefined, fakeFetch), calls };
}

const claim = { network: "eip155:84532", transaction: TX, amount: 20_000, payTo: HOST };

describe("onchain payment check", () => {
  it("confirms a successful transfer of the exact amount to the host", async () => {
    const { verify, calls } = verifierFor({ status: "0x1", logs: [transfer()] });
    expect(await verify(claim)).toBe("confirmed");
    expect(calls).toEqual([{ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [TX] }]);
  });

  it.each([
    ["the transaction reverted", { status: "0x0", logs: [transfer()] }],
    ["it paid someone else", { status: "0x1", logs: [transfer({ to: "0x2222222222222222222222222222222222222222" })] }],
    ["it paid less than claimed", { status: "0x1", logs: [transfer({ value: 19_999 })] }],
    ["it paid more than claimed", { status: "0x1", logs: [transfer({ value: 20_001 })] }],
    ["it moved a different token", { status: "0x1", logs: [transfer({ address: "0x1111111111111111111111111111111111111111" })] }],
    ["the log is not a transfer", { status: "0x1", logs: [transfer({ topic: `0x${"00".repeat(32)}` })] }],
    ["there are no logs at all", { status: "0x1", logs: [] }],
  ])("reports a mismatch when %s", async (_label, receipt) => {
    expect(await verifierFor(receipt).verify(claim)).toBe("mismatch");
  });

  it("says it cannot tell yet when the transaction is not mined or the chain is unreachable", async () => {
    expect(await verifierFor(null).verify(claim)).toBe("unknown");
    expect(await verifierFor({ status: "0x1", logs: [transfer()] }, { httpOk: false }).verify(claim)).toBe("unknown");
    expect(await verifierFor({ status: "0x1", logs: [transfer()] }, { throws: true }).verify(claim)).toBe("unknown");
  });

  it("does not call out for a network it does not know or a malformed claim", async () => {
    const { verify, calls } = verifierFor({ status: "0x1", logs: [transfer()] });
    expect(await verify({ ...claim, network: "eip155:1" })).toBe("unknown");
    expect(await verify({ ...claim, transaction: "0x1234" })).toBe("unknown");
    expect(await verify({ ...claim, payTo: "not-an-address" })).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("builds explorer links only for payments on chains it knows", () => {
    expect(explorerUrl(`eip155:84532:${TX}`)).toBe(`https://sepolia.basescan.org/tx/${TX}`);
    expect(explorerUrl(`eip155:8453:${TX}`)).toBe(`https://basescan.org/tx/${TX}`);
    expect(explorerUrl(`eip155:1:${TX}`)).toBeNull();
    expect(explorerUrl("eip155:84532:javascript:alert(1)")).toBeNull();
  });
});
