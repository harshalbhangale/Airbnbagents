import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Stands in for Stripe's API and its hosted checkout page. */
export interface FakeStripe {
  apiBase: string;
  secretKey: string;
  /** Form fields of every checkout that was created. */
  created: Record<string, string>[];
  /** Marks a checkout as paid, as if the customer completed the card page. */
  pay(id: string, overrides?: { amountTotal?: number; currency?: string }): void;
  close(): Promise<void>;
}

export async function startFakeStripe(): Promise<FakeStripe> {
  const secretKey = `sk_test_${randomBytes(12).toString("hex")}`;
  const sessions = new Map<string, Record<string, unknown>>();
  const created: Record<string, string>[] = [];
  let origin = "";

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const page = /^\/pay\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
    if (page) return send(200, `<!doctype html><title>Card payment</title><h1>Pay by card</h1><p id="session">${page[1]}</p>`, "text/html");

    if (req.headers.authorization !== `Bearer ${secretKey}`) return send(401, { error: { type: "invalid_request_error", code: "api_key_invalid" } });
    if (req.method === "POST" && path === "/v1/checkout/sessions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      if (!req.headers["idempotency-key"] || form.mode !== "payment") return send(400, { error: { type: "invalid_request_error", code: "parameter_missing" } });
      created.push(form);
      const id = `cs_test_${randomBytes(16).toString("hex")}`;
      sessions.set(id, {
        id,
        object: "checkout.session",
        url: `${origin}/pay/${id}`,
        status: "open",
        payment_status: "unpaid",
        currency: form["line_items[0][price_data][currency]"],
        amount_total: Number(form["line_items[0][price_data][unit_amount]"]),
        client_reference_id: form.client_reference_id,
        metadata: { agentbnb_account: form["metadata[agentbnb_account]"] },
      });
      return send(200, sessions.get(id));
    }
    const one = /^\/v1\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
    if (req.method === "GET" && one) {
      const session = sessions.get(one[1]!);
      return session ? send(200, session) : send(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
    }
    return send(404, { error: { type: "invalid_request_error" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    apiBase: origin,
    secretKey,
    created,
    pay: (id, overrides = {}) => {
      const session = sessions.get(id);
      if (!session) throw new Error("no such checkout");
      Object.assign(session, { status: "complete", payment_status: "paid" });
      if (overrides.amountTotal !== undefined) session.amount_total = overrides.amountTotal;
      if (overrides.currency !== undefined) session.currency = overrides.currency;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
