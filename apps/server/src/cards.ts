import { randomBytes } from "node:crypto";

export interface Checkout {
  id: string;
  /** Where the renter goes to enter card details. Hosted by the card processor, never by us. */
  url: string;
}

export interface CheckoutStatus {
  paid: boolean;
  /** How much credit the payment earns, in cents. Never more than was actually paid for it. */
  amountCents: number;
  /** The account the checkout was opened for. Null while the processor cannot say yet. */
  accountId: string | null;
}

/** A card processor. The marketplace never sees or stores card details. */
export interface CardProcessor {
  /** `returnUrl` is where the renter is sent afterwards, whether they paid or not. */
  createCheckout(request: { accountId: string; amountCents: number; returnUrl: string }): Promise<Checkout>;
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

  async createCheckout(request: { accountId: string; amountCents: number; returnUrl: string }): Promise<Checkout> {
    const session = await this.#call("POST", "/v1/checkout/sessions", {
      mode: "payment",
      success_url: `${request.returnUrl}?topup={CHECKOUT_SESSION_ID}`,
      cancel_url: request.returnUrl,
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

/**
 * Dodo Payments hosted checkout. Needs one product set up in the Dodo
 * dashboard as a one-time "Pay What You Want" product in USD; each top-up is a
 * checkout for that product at the chosen amount. Confirmation is by asking
 * Dodo for the checkout and its payment, so no public webhook address is
 * needed.
 */
export class DodoProcessor implements CardProcessor {
  readonly #key: string;
  readonly #productId: string;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;

  constructor(options: { apiKey: string; productId: string; apiBase?: string; fetch?: typeof fetch }) {
    this.#key = options.apiKey;
    this.#productId = options.productId;
    // Test keys only work against the test host, and live keys against the live one.
    const fallback = options.apiKey.startsWith("dodo_live_") ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
    this.#apiBase = (options.apiBase ?? fallback).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#key}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new CardProcessorError("the card processor could not be reached");
    }
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !parsed) {
      const code = parsed?.code;
      throw new CardProcessorError(`the card processor refused the request (${typeof code === "string" ? code : response.status})`);
    }
    return parsed;
  }

  async createCheckout(request: { accountId: string; amountCents: number; returnUrl: string }): Promise<Checkout> {
    const session = await this.#call("POST", "/checkouts", {
      product_cart: [{ product_id: this.#productId, quantity: 1, amount: request.amountCents }],
      billing_currency: "USD",
      // Dodo adds its own payment details to this address but not the checkout's id, so the console remembers that itself.
      return_url: `${request.returnUrl}?topup=return`,
      metadata: { agentbnb_account: request.accountId, agentbnb_amount_cents: request.amountCents },
    });
    if (typeof session.session_id !== "string" || typeof session.checkout_url !== "string") {
      throw new CardProcessorError("the card processor returned no checkout page");
    }
    return { id: session.session_id, url: session.checkout_url };
  }

  async getCheckout(id: string): Promise<CheckoutStatus> {
    if (!/^cks_[A-Za-z0-9_]{6,250}$/.test(id)) throw new CardProcessorError("that is not a checkout reference");
    const pending: CheckoutStatus = { paid: false, amountCents: 0, accountId: null };
    const session = await this.#call("GET", `/checkouts/${id}`);
    // There is no payment to look at until the customer has submitted their details.
    if (typeof session.payment_id !== "string" || !/^[A-Za-z0-9_]{6,250}$/.test(session.payment_id)) return pending;

    const payment = await this.#call("GET", `/payments/${session.payment_id}`);
    // The payment must say it belongs to this checkout; otherwise it proves nothing about it.
    if (payment.checkout_session_id !== id) return pending;
    const metadata = (payment.metadata ?? {}) as { agentbnb_account?: unknown; agentbnb_amount_cents?: unknown };
    const accountId = typeof metadata.agentbnb_account === "string" ? metadata.agentbnb_account : null;
    if (payment.status !== "succeeded") return { ...pending, accountId };

    const asked = Number(metadata.agentbnb_amount_cents);
    if (!Number.isSafeInteger(asked) || asked <= 0) return { ...pending, accountId };
    // Credit what was asked for, but never more than was paid before tax when that can be read in dollars.
    let amountCents = asked;
    if (payment.currency === "USD" && typeof payment.total_amount === "number") {
      const beforeTax = payment.total_amount - (typeof payment.tax === "number" ? payment.tax : 0);
      amountCents = Math.max(0, Math.min(asked, beforeTax));
    }
    return { paid: amountCents > 0, amountCents, accountId };
  }
}
