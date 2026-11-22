import { randomBytes } from "node:crypto";

export interface Checkout {
  id: string;
  /** Where the renter goes to enter card details. Hosted by the card processor, never by us. */
  url: string;
}

export interface CheckoutStatus {
  paid: boolean;
  /** What was actually charged, in cents. */
  amountCents: number;
  /** The account the checkout was opened for. */
  accountId: string | null;
}

/** A card processor. The marketplace never sees or stores card details. */
export interface CardProcessor {
  createCheckout(request: { accountId: string; amountCents: number; successUrl: string; cancelUrl: string }): Promise<Checkout>;
  getCheckout(id: string): Promise<CheckoutStatus>;
}

export class CardProcessorError extends Error {}

/**
 * Stripe Checkout, called over its REST API. Confirmation is by asking Stripe
 * for the session's state, so no public webhook address is needed.
 */
export class StripeProcessor implements CardProcessor {
  readonly #key: string;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;

  constructor(options: { secretKey: string; apiBase?: string; fetch?: typeof fetch }) {
    this.#key = options.secretKey;
    this.#apiBase = (options.apiBase ?? "https://api.stripe.com").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  async #call(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#key}`,
          ...(form ? { "content-type": "application/x-www-form-urlencoded", "idempotency-key": randomBytes(16).toString("hex") } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new CardProcessorError("the card processor could not be reached");
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !body) {
      const code = (body?.error as { code?: unknown; type?: unknown } | undefined)?.code ?? (body?.error as { type?: unknown } | undefined)?.type;
      throw new CardProcessorError(`the card processor refused the request${typeof code === "string" ? ` (${code})` : ""}`);
    }
    return body;
  }

  async createCheckout(request: { accountId: string; amountCents: number; successUrl: string; cancelUrl: string }): Promise<Checkout> {
    const session = await this.#call("POST", "/v1/checkout/sessions", {
      mode: "payment",
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      client_reference_id: request.accountId,
      "metadata[agentbnb_account]": request.accountId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(request.amountCents),
      "line_items[0][price_data][product_data][name]": "agentbnb credit",
    });
    if (typeof session.id !== "string" || typeof session.url !== "string") throw new CardProcessorError("the card processor returned no checkout page");
    return { id: session.id, url: session.url };
  }

  async getCheckout(id: string): Promise<CheckoutStatus> {
    if (!/^cs_[A-Za-z0-9_]{8,250}$/.test(id)) throw new CardProcessorError("that is not a checkout reference");
    const session = await this.#call("GET", `/v1/checkout/sessions/${id}`);
    const metadata = session.metadata as { agentbnb_account?: unknown } | null | undefined;
    return {
      paid: session.payment_status === "paid" && session.currency === "usd",
      amountCents: typeof session.amount_total === "number" ? session.amount_total : 0,
      accountId: typeof metadata?.agentbnb_account === "string" ? metadata.agentbnb_account : null,
    };
  }
}
