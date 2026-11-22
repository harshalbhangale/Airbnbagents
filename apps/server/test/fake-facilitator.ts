import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyTypedData } from "viem";

/**
 * Stands in for the x402 facilitator and the chain behind it. It checks the
 * agent's signed authorization for real (signature, recipient, amount, expiry,
 * one use per nonce, balance) and keeps token balances in memory.
 */
export interface FakeFacilitator {
  url: string;
  network: string;
  balances: Map<string, bigint>;
  settlements: { transaction: string; from: string; to: string; value: bigint }[];
  verifyCalls: number;
  failNextSettle: boolean;
  fund(address: string, microUsd: number): void;
  balanceOf(address: string): number;
  close(): Promise<void>;
}

const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export async function startFakeFacilitator(network = "eip155:84532"): Promise<FakeFacilitator> {
  const balances = new Map<string, bigint>();
  const usedNonces = new Set<string>();
  const state = {
    settlements: [] as FakeFacilitator["settlements"],
    verifyCalls: 0,
    failNextSettle: false,
  };

  async function check(body: any): Promise<{ ok: true; from: string; to: string; value: bigint; nonceKey: string } | { ok: false; reason: string }> {
    const requirements = body.paymentRequirements;
    const authorization = body.paymentPayload?.payload?.authorization;
    const signature = body.paymentPayload?.payload?.signature;
    if (!authorization || !signature) return { ok: false, reason: "invalid_payload" };
    const valid = await verifyTypedData({
      address: authorization.from,
      domain: {
        name: requirements.extra.name,
        version: requirements.extra.version,
        chainId: Number(network.split(":")[1]),
        verifyingContract: requirements.asset,
      },
      types,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    }).catch(() => false);
    if (!valid) return { ok: false, reason: "invalid_signature" };
    if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) return { ok: false, reason: "recipient_mismatch" };
    if (BigInt(authorization.value) !== BigInt(requirements.amount)) return { ok: false, reason: "amount_mismatch" };
    if (BigInt(authorization.validBefore) <= BigInt(Math.floor(Date.now() / 1000))) return { ok: false, reason: "expired" };
    const from = authorization.from.toLowerCase();
    const nonceKey = `${from}:${authorization.nonce.toLowerCase()}`;
    if (usedNonces.has(nonceKey)) return { ok: false, reason: "nonce_already_used" };
    if ((balances.get(from) ?? 0n) < BigInt(authorization.value)) return { ok: false, reason: "insufficient_balance" };
    return { ok: true, from, to: authorization.to.toLowerCase(), value: BigInt(authorization.value), nonceKey };
  }

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url?.endsWith("/supported")) {
        return send(200, { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const verdict = await check(body);
      if (req.url?.endsWith("/verify")) {
        state.verifyCalls++;
        return send(200, verdict.ok ? { isValid: true, payer: verdict.from } : { isValid: false, invalidReason: verdict.reason });
      }
      if (req.url?.endsWith("/settle")) {
        if (state.failNextSettle) {
          state.failNextSettle = false;
          return send(200, { success: false, errorReason: "simulated_chain_failure", transaction: "", network });
        }
        if (!verdict.ok) return send(200, { success: false, errorReason: verdict.reason, transaction: "", network });
        usedNonces.add(verdict.nonceKey);
        balances.set(verdict.from, (balances.get(verdict.from) ?? 0n) - verdict.value);
        balances.set(verdict.to, (balances.get(verdict.to) ?? 0n) + verdict.value);
        const transaction = `0x${randomBytes(32).toString("hex")}`;
        state.settlements.push({ transaction, from: verdict.from, to: verdict.to, value: verdict.value });
        return send(200, { success: true, transaction, network, payer: verdict.from });
      }
      return send(404, { error: "not found" });
    } catch {
      send(500, { error: "bad request" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    network,
    balances,
    fund: (address: string, microUsd: number) => void balances.set(address.toLowerCase(), BigInt(microUsd)),
    balanceOf: (address: string) => Number(balances.get(address.toLowerCase()) ?? 0n),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
