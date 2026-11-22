import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Stands in for the Dodo Payments API and its hosted checkout page, following its documented shapes. */
export interface FakeDodo {
  apiBase: string;
  apiKey: string;
  productId: string;
  /** JSON bodies of every checkout that was created. */
  created: Record<string, any>[];
  /** Completes a checkout as the customer would, creating its payment. Returns the payment id. */
  pay(sessionId: string, overrides?: { status?: string; tax?: number; currency?: string; totalAmount?: number; checkoutSessionId?: string; metadata?: Record<string, unknown> }): string;
  close(): Promise<void>;
}

export async function startFakeDodo(): Promise<FakeDodo> {
  const apiKey = `dodo_test_${randomBytes(12).toString("hex")}`;
  const productId = `pdt_${randomBytes(8).toString("hex")}`;
  const sessions = new Map<string, { body: Record<string, any>; paymentId: string | null }>();
  const payments = new Map<string, Record<string, unknown>>();
  const created: Record<string, any>[] = [];
  let origin = "";

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const page = /^\/session\/(cks_[A-Za-z0-9]+)$/.exec(path);
    if (page) return send(200, `<!doctype html><title>Checkout</title><h1>Pay by card</h1><p id="session">${page[1]}</p>`, "text/html");

    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { code: "UNAUTHORIZED", message: "invalid api key" });

    if (req.method === "POST" && path === "/checkouts") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const item = body.product_cart?.[0];
      if (!item || item.product_id !== productId) return send(404, { code: "PRODUCT_NOT_FOUND", message: "no such product" });
      if (!Number.isInteger(item.amount) || item.amount < 100) return send(422, { code: "AMOUNT_BELOW_MINIMUM", message: "below the minimum price" });
      created.push(body);
      const id = `cks_${randomBytes(12).toString("hex")}`;
      sessions.set(id, { body, paymentId: null });
      return send(200, { session_id: id, checkout_url: `${origin}/session/${id}` });
    }
    const checkout = /^\/checkouts\/(cks_[A-Za-z0-9]+)$/.exec(path);
    if (req.method === "GET" && checkout) {
      const session = sessions.get(checkout[1]!);
      if (!session) return send(404, { code: "NOT_FOUND", message: "no such checkout" });
      const payment = session.paymentId ? payments.get(session.paymentId) : null;
      return send(200, {
        id: checkout[1],
        created_at: new Date().toISOString(),
        customer_email: payment ? "customer@example.com" : null,
        customer_name: null,
        payment_id: session.paymentId,
        payment_status: payment?.status ?? null,
      });
    }
    const payment = /^\/payments\/(pay_[A-Za-z0-9]+)$/.exec(path);
    if (req.method === "GET" && payment) {
      const found = payments.get(payment[1]!);
      return found ? send(200, found) : send(404, { code: "NOT_FOUND", message: "no such payment" });
    }
    return send(404, { code: "NOT_FOUND" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    apiBase: origin,
    apiKey,
    productId,
    created,
    pay: (sessionId, overrides = {}) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("no such checkout");
      const item = session.body.product_cart[0];
      const tax = overrides.tax ?? 0;
      const paymentId = `pay_${randomBytes(10).toString("hex")}`;
      payments.set(paymentId, {
        payment_id: paymentId,
        status: overrides.status ?? "succeeded",
        total_amount: overrides.totalAmount ?? item.amount * item.quantity + tax,
        tax,
        currency: overrides.currency ?? "USD",
        metadata: overrides.metadata ?? session.body.metadata ?? {},
        checkout_session_id: overrides.checkoutSessionId ?? sessionId,
        created_at: new Date().toISOString(),
        product_cart: session.body.product_cart,
      });
      session.paymentId = paymentId;
      return paymentId;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
