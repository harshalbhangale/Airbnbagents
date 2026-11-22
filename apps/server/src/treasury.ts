import { x402Client } from "@x402/core/client";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { Challenge } from "./payments.ts";

type Wallet = Parameters<typeof toClientEvmSigner>[0] & { address: string };

/**
 * The marketplace's own USDC wallet. When a renter pays with card credit, this
 * wallet pays the host for them, through the same x402 payment an agent with
 * its own wallet would make. Hosts are therefore always paid in USDC, straight
 * to their address, whichever way the renter paid.
 */
export class Treasury {
  readonly address: string;
  readonly #client: x402Client;

  constructor(wallet: Wallet, options: { maxPerTaskUsd?: number } = {}) {
    this.address = wallet.address;
    this.#client = x402Client.fromConfig({
      schemes: [{ network: "eip155:*", client: new ExactEvmScheme(toClientEvmSigner(wallet)) }],
      spendControls: { maxAmountPerPayment: `$${options.maxPerTaskUsd ?? 5}` },
    });
  }

  /** Signs an authorization for exactly what the challenge asks. Nothing moves until it is settled. */
  async authorize(challenge: Challenge): Promise<Awaited<ReturnType<x402Client["createPaymentPayload"]>>> {
    return this.#client.createPaymentPayload(challenge.body as Parameters<x402Client["createPaymentPayload"]>[0]);
  }
}
