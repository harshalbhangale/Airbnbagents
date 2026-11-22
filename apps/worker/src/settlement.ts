/** Chains the worker knows how to check a payment on. Addresses are the USDC token contracts. */
export const NETWORKS: Readonly<Record<string, { name: string; rpcUrl: string; usdc: string; explorerTx: string }>> = {
  "eip155:84532": {
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    explorerTx: "https://sepolia.basescan.org/tx/",
  },
  "eip155:8453": {
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    explorerTx: "https://basescan.org/tx/",
  },
};

export interface ReportedSettlement {
  network: string;
  /** Transaction hash. */
  transaction: string;
  /** Micro-dollars, which is USDC's own smallest unit. */
  amount: number;
  /** The host's payout address. */
  payTo: string;
}

/**
 * confirmed  the transaction succeeded and moved exactly this amount of USDC to the host
 * mismatch   the transaction exists but does not do that
 * unknown    could not tell yet (not mined, or the chain could not be reached)
 */
export type SettlementCheck = "confirmed" | "mismatch" | "unknown";
export type SettlementVerifier = (settlement: ReportedSettlement) => Promise<SettlementCheck>;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Checks a reported payment against the chain itself, so a host's earnings do
 * not rest on the marketplace's word. Reads one transaction receipt over
 * plain JSON-RPC; needs no wallet and no keys.
 */
export function rpcSettlementVerifier(networks: typeof NETWORKS = NETWORKS, fetchImpl: typeof fetch = fetch): SettlementVerifier {
  return async ({ network, transaction, amount, payTo }) => {
    const chain = networks[network];
    if (!chain || !/^0x[0-9a-f]{64}$/.test(transaction) || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) return "unknown";
    let receipt: { status?: string; logs?: { address?: string; topics?: string[]; data?: string }[] } | null;
    try {
      const response = await fetchImpl(chain.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [transaction] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return "unknown";
      const body = (await response.json()) as { result?: typeof receipt; error?: unknown };
      if (body.error || body.result === undefined) return "unknown";
      receipt = body.result;
    } catch {
      return "unknown";
    }
    if (receipt === null) return "unknown";
    if (receipt.status !== "0x1") return "mismatch";
    const recipient = `0x${payTo.slice(2).toLowerCase().padStart(64, "0")}`;
    const paid = (receipt.logs ?? []).some((log) => {
      if (log.address?.toLowerCase() !== chain.usdc || log.topics?.[0] !== TRANSFER_TOPIC) return false;
      if (log.topics[2]?.toLowerCase() !== recipient) return false;
      try {
        return BigInt(log.data ?? "0x") === BigInt(amount);
      } catch {
        return false;
      }
    });
    return paid ? "confirmed" : "mismatch";
  };
}

export function explorerUrl(paymentId: string): string | null {
  const split = paymentId.lastIndexOf(":");
  const chain = NETWORKS[paymentId.slice(0, split)];
  const transaction = paymentId.slice(split + 1);
  return chain && /^0x[0-9a-f]{64}$/.test(transaction) ? `${chain.explorerTx}${transaction}` : null;
}
