import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";

type Requirements = Awaited<ReturnType<x402ResourceServer["buildPaymentRequirements"]>>[number];
type Payload = ReturnType<typeof decodePaymentSignatureHeader>;
type Network = `${string}:${string}`;

export interface PaymentConfig {
  /** x402 facilitator that verifies and settles payments. */
  facilitatorUrl: string;
  /** CAIP-2 network id, for example eip155:84532 for Base Sepolia. */
  network: string;
}

export interface Challenge {
  requirements: Requirements[];
  /** Value for the PAYMENT-REQUIRED response header. */
  header: string;
  body: unknown;
}

export interface VerifiedPayment {
  payload: Payload;
  requirements: Requirements;
  payer: string | null;
  /** Identifies this one authorization, so it cannot be used for two tasks at once. */
  key: string;
}

export interface Settlement {
  transaction: string;
  network: string;
  /** Micro-dollars, which is the token's own smallest unit. */
  amount: number;
  payer: string | null;
  /** Value for the PAYMENT-RESPONSE response header. */
  header: string;
}

export class PaymentError extends Error {
  constructor(readonly code: "invalid_payment" | "settlement_failed", message: string) {
    super(message);
  }
}

/**
 * x402 "exact" payments in USDC. The agent signs an authorization for the
 * exact price; it is checked before the task runs and only submitted onchain
 * once the worker has returned a result, so a task that is denied, rejected or
 * withheld costs the agent nothing.
 */
export class PaymentGate {
  readonly #server: x402ResourceServer;
  readonly #network: Network;

  private constructor(server: x402ResourceServer, network: Network) {
    this.#server = server;
    this.#network = network;
  }

  static async create(config: PaymentConfig): Promise<PaymentGate> {
    const network = config.network as Network;
    const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 30_000 })).register(
      network,
      new ExactEvmScheme(),
    );
    await server.initialize();
    if (!server.getSupportedKind(2, network, "exact")) {
      throw new Error(`the facilitator does not support exact payments on ${config.network}`);
    }
    return new PaymentGate(server, network);
  }

  get network(): string {
    return this.#network;
  }

  /** Builds the 402 answer for a task costing `priceMicroUsd`, paid to `payTo`. */
  async challenge(priceMicroUsd: number, payTo: string, resource: { url: string; description: string }, error?: string): Promise<Challenge> {
    if (!Number.isSafeInteger(priceMicroUsd) || priceMicroUsd <= 0) throw new RangeError("price must be a positive whole number of micro-dollars");
    const requirements = await this.#server.buildPaymentRequirements({
      scheme: "exact",
      network: this.#network,
      payTo,
      price: `$${(priceMicroUsd / 1_000_000).toFixed(6)}`,
      maxTimeoutSeconds: 120,
    });
    const only = requirements[0];
    // The quoted token amount must be exactly the host's price; anything else would be a silent mispricing.
    if (requirements.length !== 1 || !only || only.amount !== String(priceMicroUsd) || only.payTo.toLowerCase() !== payTo.toLowerCase()) {
      throw new Error("payment requirements do not match the quoted price");
    }
    const required = await this.#server.createPaymentRequiredResponse(requirements, { ...resource, mimeType: "application/json" }, error);
    return { requirements, header: encodePaymentRequiredHeader(required), body: required };
  }

  /** Checks a PAYMENT-SIGNATURE header against the challenge. Nothing moves onchain yet. */
  async verify(header: string, challenge: Challenge): Promise<VerifiedPayment> {
    let payload: Payload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      throw new PaymentError("invalid_payment", "payment header could not be read");
    }
    return this.verifyPayload(payload, challenge);
  }

  /** The same check for a payment that did not arrive as a header, such as one the marketplace's own wallet signed. */
  async verifyPayload(payload: Payload, challenge: Challenge): Promise<VerifiedPayment> {
    const requirements = this.#server.findMatchingRequirements(challenge.requirements, payload);
    if (!requirements) throw new PaymentError("invalid_payment", "payment does not match the quoted price");
    let verdict;
    try {
      verdict = await this.#server.verifyPayment(payload, requirements);
    } catch {
      throw new PaymentError("invalid_payment", "payment could not be verified");
    }
    if (!verdict.isValid) throw new PaymentError("invalid_payment", verdict.invalidReason ?? "payment is not valid");
    const authorization = (payload.payload as { authorization?: { from?: unknown; nonce?: unknown } }).authorization;
    const key = `${String(authorization?.from).toLowerCase()}:${String(authorization?.nonce).toLowerCase()}`;
    return { payload, requirements, payer: verdict.payer ?? null, key };
  }

  /** Submits the verified payment onchain. */
  async settle(payment: VerifiedPayment): Promise<Settlement> {
    let response;
    try {
      response = await this.#server.settlePayment(payment.payload, payment.requirements);
    } catch {
      throw new PaymentError("settlement_failed", "settlement could not be completed");
    }
    if (!response.success || !/^0x[0-9a-fA-F]{64}$/.test(response.transaction)) {
      throw new PaymentError("settlement_failed", response.errorReason ?? "settlement failed");
    }
    return {
      transaction: response.transaction.toLowerCase(),
      network: response.network,
      amount: Number(response.amount ?? payment.requirements.amount),
      payer: response.payer ?? payment.payer,
      header: encodePaymentResponseHeader(response),
    };
  }
}
