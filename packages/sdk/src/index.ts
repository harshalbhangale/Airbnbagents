import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  openResult,
  sealRequest,
  type Reason,
  type Receipt,
  type Status,
  type WithheldReason,
} from "@agentbnb/protocol";

/** A wallet that can sign typed data, such as a viem account. Only testnet or spending-limited keys belong here. */
export type AgentWallet = Parameters<typeof toClientEvmSigner>[0];

export interface AgentClientOptions {
  /** Marketplace address. */
  baseUrl: string;
  /** Needed for paid tasks. Without it, a task that costs money fails with `PaymentRequiredError`. */
  wallet?: AgentWallet;
  /** The most this client will pay for one task, in micro-dollars. Defaults to $0.10. */
  maxPriceMicroUsd?: number;
  fetch?: typeof fetch;
}

export interface WorkerListing {
  workerKeyId: string;
  encryptionKey: string;
  signingKey: string;
  policyHash: string;
  online: boolean;
  payoutAddress: string;
  capabilities: { id: string; title: string; description: string; fields: { name: string; label: string; available: boolean; alwaysBlocked: boolean }[] }[];
  offers: ({ kind: string } & Record<string, unknown>)[];
}

export interface TaskOutcome {
  taskId: string;
  status: Status;
  reason: Reason | null;
  /** The approved fields, or null when nothing was returned. */
  data: Record<string, unknown> | null;
  withheld: { field: string; reason: WithheldReason }[];
  detectors: string[];
  /** The worker's signed receipt, already verified. */
  receipt: Receipt;
  /** Present only when the task completed and was paid for. */
  payment: { transaction: string; network: string; amount: number; payTo: string } | null;
}

export class PaymentRequiredError extends Error {
  constructor(message: string, readonly priceMicroUsd: number | null) {
    super(message);
  }
}

export class MarketplaceError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`marketplace answered ${status}: ${code}`);
  }
}

/**
 * What an agent uses to rent a capability: find a worker, encrypt the task to
 * it, pay if asked, then verify and decrypt the answer. The marketplace in the
 * middle only ever sees ciphertext.
 */
export class AgentClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maxPrice: number;
  readonly #payments: x402HTTPClient | null;

  constructor(options: AgentClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#maxPrice = options.maxPriceMicroUsd ?? 100_000;
    this.#payments = options.wallet
      ? new x402HTTPClient(new x402Client().register("eip155:*", new ExactEvmScheme(toClientEvmSigner(options.wallet))))
      : null;
  }

  async listWorkers(): Promise<WorkerListing[]> {
    const response = await this.#fetch(`${this.#baseUrl}/workers`);
    if (!response.ok) throw new MarketplaceError(response.status, "list_failed");
    return ((await response.json()) as { workers: WorkerListing[] }).workers;
  }

  async getWorker(workerKeyId: string): Promise<WorkerListing> {
    const response = await this.#fetch(`${this.#baseUrl}/workers/${encodeURIComponent(workerKeyId)}`);
    if (!response.ok) throw new MarketplaceError(response.status, "worker_not_found");
    return (await response.json()) as WorkerListing;
  }

  /**
   * Runs one task on one worker. `worker` should be a listing the agent has
   * already decided to trust: the task is encrypted to the key in it, and the
   * receipt is checked against the signing key in it.
   */
  async runTask(args: { worker: WorkerListing; capability: string; input: Record<string, unknown> }): Promise<TaskOutcome> {
    const { worker } = args;
    const prepared = await sealRequest({
      capability: args.capability,
      input: args.input,
      workerPublicKey: worker.encryptionKey,
      workerKeyId: worker.workerKeyId,
    });
    const send = (headers: Record<string, string> = {}) =>
      this.#fetch(`${this.#baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(prepared.request),
      });

    let response = await send();
    if (response.status === 402) {
      const body = await response.json().catch(() => undefined);
      if (!this.#payments) throw new PaymentRequiredError("this task costs money and no wallet was provided", null);
      const required = this.#payments.getPaymentRequiredResponse((name) => response.headers.get(name), body);
      const quoted = required.accepts[0];
      const price = quoted ? Number(quoted.amount) : NaN;
      if (!quoted || required.accepts.length !== 1 || !Number.isSafeInteger(price)) {
        throw new PaymentRequiredError("the payment request could not be understood", null);
      }
      if (price > this.#maxPrice) throw new PaymentRequiredError("the price is above this client's limit", price);
      // Pay the host named in the listing the agent chose, not whoever the 402 names.
      if (quoted.payTo.toLowerCase() !== worker.payoutAddress.toLowerCase()) {
        throw new PaymentRequiredError("the payment request names a different recipient than the worker's listing", price);
      }
      const payload = await this.#payments.createPaymentPayload(required);
      response = await send(this.#payments.encodePaymentSignatureHeader(payload));
      if (response.status === 402) {
        const again = (await response.json().catch(() => ({}))) as { error?: string };
        throw new PaymentRequiredError(`payment was not accepted: ${again.error ?? "unknown reason"}`, price);
      }
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new MarketplaceError(response.status, body.error ?? "unknown");
    }

    const body = (await response.json()) as { result: unknown; payment: TaskOutcome["payment"] };
    const opened = await openResult({
      result: body.result,
      request: prepared.request,
      replyKeys: prepared.replyKeys,
      workerSigningKey: worker.signingKey,
    });
    return {
      taskId: prepared.request.taskId,
      status: opened.status,
      reason: opened.reason,
      data: opened.body?.data ?? null,
      withheld: opened.body?.withheld ?? [],
      detectors: opened.body?.detectors ?? [],
      receipt: opened.receipt,
      payment: opened.status === "ok" ? (body.payment ?? null) : null,
    };
  }
}
