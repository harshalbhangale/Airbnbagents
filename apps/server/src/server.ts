import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ResultVerificationError,
  sealedRequestSchema,
  verifyResultEnvelope,
  type Reason,
  type SealedRequest,
  type SealedResult,
  type Status,
} from "@agentbnb/protocol";
import { AccountStore } from "./accounts.ts";
import { CardProcessorError, type CardProcessor } from "./cards.ts";
import { WorkerHub, WorkerUnavailableError, type WorkerRecord } from "./hub.ts";
import type { Treasury } from "./treasury.ts";
import { PaymentError, PaymentGate, type Challenge, type PaymentConfig, type VerifiedPayment } from "./payments.ts";

export interface MarketplaceOptions extends PaymentConfig {
  port?: number;
  /** Public address of this server, used in payment requests. Defaults to the local address. */
  publicUrl?: string;
  /**
   * Turns on paying by card. Renters buy prepaid credit through the card
   * processor, and the treasury wallet pays hosts in USDC on their behalf.
   */
  card?: { processor: CardProcessor; treasury: Treasury };
  /** Where renter accounts and their credit are kept. In memory only if omitted. */
  accountsFile?: string;
  /** Smallest and largest card top-up, in whole dollars. */
  topUpLimitsUsd?: { min: number; max: number };
  /** Most new renter accounts the marketplace will open in a minute, across everyone. */
  maxNewAccountsPerMinute?: number;
}

/** What the marketplace knows about a task: routing, outcome and payment. Never its content. */
export interface TaskRecord {
  taskId: string;
  workerKeyId: string;
  capability: string;
  status: Status | "unavailable" | "unverified";
  reason: Reason | null;
  priceMicroUsd: number | null;
  transaction: string | null;
  /** How the renter paid, when they did. */
  paidWith: "crypto" | "credit" | null;
  at: number;
}

export interface Marketplace {
  url: string;
  /** ws:// address host workers connect to. */
  hostUrl: string;
  tasks(): readonly TaskRecord[];
  accounts: AccountStore;
  close(): Promise<void>;
}

const MAX_BODY = 300_000;
const MAINNETS: ReadonlySet<string> = new Set(["eip155:8453"]);

class Unauthorized extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new RangeError("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicWorker(record: WorkerRecord) {
  const { connectedAt: _connectedAt, ...rest } = record;
  return rest;
}

/**
 * The marketplace: lists connected workers, puts task creation behind an x402
 * paywall, and relays encrypted tasks. It cannot read a task or its result.
 */
export async function startMarketplace(options: MarketplaceOptions): Promise<Marketplace> {
  const gate = await PaymentGate.create(options);
  const hub = new WorkerHub();
  const tasks: TaskRecord[] = [];
  const inFlightPayments = new Set<string>();
  const accounts = new AccountStore(options.accountsFile);
  const recentAccounts: number[] = [];
  const card = options.card;
  const limits = options.topUpLimitsUsd ?? { min: 5, max: 500 };
  const consoleFile = (name: string) => readFileSync(new URL(`./console/${name}`, import.meta.url));
  const consoleFiles: Record<string, { type: string; body: Buffer }> = {
    "/console": { type: "text/html; charset=utf-8", body: consoleFile("index.html") },
    "/console/app.js": { type: "text/javascript; charset=utf-8", body: consoleFile("app.js") },
    "/console/app.css": { type: "text/css; charset=utf-8", body: consoleFile("app.css") },
  };

  /** The account behind a request's API key, or null if it carries none. Throws on a bad key. */
  const accountFor = (req: IncomingMessage): string | null => {
    const header = req.headers.authorization;
    if (header === undefined) return null;
    const match = /^Bearer (\S+)$/.exec(header);
    const accountId = match ? accounts.authenticate(match[1]!) : null;
    if (!accountId) throw new Unauthorized();
    return accountId;
  };

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  const record = (request: SealedRequest, patch: Partial<TaskRecord> & Pick<TaskRecord, "status">) => {
    tasks.push({
      taskId: request.taskId,
      workerKeyId: request.workerKeyId,
      capability: request.capability,
      reason: null,
      priceMicroUsd: null,
      transaction: null,
      paidWith: null,
      at: Date.now(),
      ...patch,
    });
    if (tasks.length > 5_000) tasks.splice(0, tasks.length - 5_000);
  };

  let baseUrl = options.publicUrl ?? "";

  async function createTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: "invalid_body" });
    }
    const parsed = sealedRequestSchema.safeParse(body);
    if (!parsed.success) return json(res, 400, { error: "invalid_request" });
    const request = parsed.data;

    const worker = hub.worker(request.workerKeyId);
    if (!worker) return json(res, 404, { error: "worker_not_found" });

    // The price is whatever the host set for this capability. No offer means nothing to charge for:
    // the request is still passed on, and the worker's own rules decide what happens to it.
    const offer = worker.offers.find((o) => o.kind === "automation_session" && o.capability === request.capability);
    const price = offer && offer.kind === "automation_session" ? offer.pricePerSession : null;

    const accountId = accountFor(req);
    let challenge: Challenge | null = null;
    let payment: VerifiedPayment | null = null;
    let reservation: string | null = null;
    const resource = { url: `${baseUrl}/tasks`, description: `${request.capability} on worker ${worker.workerKeyId}` };

    if (price !== null) {
      challenge = await gate.challenge(price, worker.payoutAddress, resource);
      if (accountId) {
        // Paying with card credit: hold the credit, and have the marketplace's wallet pay the host.
        if (!card) return json(res, 503, { error: "card_payments_unavailable" });
        // Credit is charged without the agent signing anything, so it can state the most it will pay.
        const cap = req.headers["x-agentbnb-max-price"];
        if (typeof cap === "string" && /^\d{1,12}$/.test(cap) && price > Number(cap)) {
          return json(res, 409, { error: "price_above_limit", priceMicroUsd: price });
        }
        reservation = accounts.reserve(accountId, price);
        if (!reservation) {
          const body = { ...(challenge.body as object), credit: { requiredMicroUsd: price, availableMicroUsd: accounts.available(accountId) } };
          return json(res, 402, body, { "PAYMENT-REQUIRED": challenge.header });
        }
        try {
          payment = await gate.verifyPayload(await card.treasury.authorize(challenge), challenge);
        } catch {
          accounts.release(reservation);
          return json(res, 503, { error: "treasury_unavailable" });
        }
      } else {
        const header = req.headers["payment-signature"];
        if (typeof header !== "string") {
          return json(res, 402, challenge.body, { "PAYMENT-REQUIRED": challenge.header });
        }
        try {
          payment = await gate.verify(header, challenge);
        } catch (error) {
          const reason = error instanceof PaymentError ? error.message : "payment is not valid";
          const retry = await gate.challenge(price, worker.payoutAddress, resource, reason);
          return json(res, 402, retry.body, { "PAYMENT-REQUIRED": retry.header });
        }
        // One signed authorization pays for one task. Refuse to run two tasks against it at the same time.
        if (inFlightPayments.has(payment.key)) return json(res, 409, { error: "payment_in_use" });
      }
      inFlightPayments.add(payment.key);
    }

    try {
      let result: SealedResult;
      try {
        const raw = await hub.dispatch(request);
        // Checked before any money moves: the answer must be signed by this worker and be for this exact request.
        result = verifyResultEnvelope({ result: raw, request, workerSigningKey: worker.signingKey });
      } catch (error) {
        if (error instanceof ResultVerificationError) {
          record(request, { status: "unverified", priceMicroUsd: price });
          return json(res, 502, { error: "worker_result_unverified" });
        }
        if (error instanceof WorkerUnavailableError) {
          record(request, { status: "unavailable", priceMicroUsd: price });
          return json(res, 503, { error: "worker_unavailable" });
        }
        throw error;
      }

      // Only a completed task is charged for.
      if (result.status !== "ok" || !payment) {
        record(request, { status: result.status, reason: result.reason, priceMicroUsd: price });
        return json(res, 200, { result, payment: null });
      }

      let settlement;
      try {
        settlement = await gate.settle(payment);
      } catch (error) {
        // The work was done but the payment did not go through, so the result is not released.
        record(request, { status: result.status, reason: result.reason, priceMicroUsd: price });
        if (reservation) return json(res, 502, { error: "settlement_failed" });
        const reason = error instanceof PaymentError ? error.message : "settlement failed";
        const retry = await gate.challenge(price!, worker.payoutAddress, resource, reason);
        return json(res, 402, retry.body, { "PAYMENT-REQUIRED": retry.header });
      }
      if (reservation) {
        accounts.commit(reservation, { taskId: request.taskId, capability: request.capability, transaction: settlement.transaction });
        reservation = null;
      }
      const paidWith = accountId ? ("credit" as const) : ("crypto" as const);
      record(request, { status: "ok", priceMicroUsd: price, transaction: settlement.transaction, paidWith });
      hub.notifySettled(worker.workerKeyId, {
        network: settlement.network,
        transaction: settlement.transaction,
        amount: settlement.amount,
        taskId: request.taskId,
      });
      return json(
        res,
        200,
        {
          result,
          payment: {
            transaction: settlement.transaction,
            network: settlement.network,
            amount: settlement.amount,
            payTo: worker.payoutAddress,
            paidWith,
            ...(accountId ? { creditRemainingMicroUsd: accounts.available(accountId) } : {}),
          },
        },
        { "PAYMENT-RESPONSE": settlement.header },
      );
    } finally {
      if (payment) inFlightPayments.delete(payment.key);
      // Anything still held here means the task did not complete: the renter keeps their credit.
      if (reservation) accounts.release(reservation);
    }
  }

  async function accountRoutes(route: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (route === "POST /accounts") {
      // Opening an account is free and needs no sign-in, so it is capped to keep it from being used to fill the disk.
      const now = Date.now();
      while (recentAccounts.length && now - recentAccounts[0]! > 60_000) recentAccounts.shift();
      if (recentAccounts.length >= (options.maxNewAccountsPerMinute ?? 30)) return json(res, 429, { error: "too_many_new_accounts" }), true;
      recentAccounts.push(now);
      json(res, 201, { ...accounts.create(), cardPayments: Boolean(card) });
      return true;
    }
    if (!route.startsWith("GET /account") && !route.startsWith("POST /account")) return false;
    const accountId = accountFor(req);
    if (!accountId) throw new Unauthorized();

    if (route === "GET /account") {
      json(res, 200, {
        accountId,
        creditMicroUsd: accounts.available(accountId),
        cardPayments: Boolean(card),
        topUpLimitsUsd: limits,
        history: accounts.history(accountId),
      });
      return true;
    }
    if (route === "POST /account/topups") {
      if (!card) return json(res, 503, { error: "card_payments_unavailable" }), true;
      const body = (await readJson(req).catch(() => null)) as { amountUsd?: unknown } | null;
      const amountUsd = body?.amountUsd;
      if (typeof amountUsd !== "number" || !Number.isInteger(amountUsd) || amountUsd < limits.min || amountUsd > limits.max) {
        return json(res, 400, { error: "invalid_amount", minUsd: limits.min, maxUsd: limits.max }), true;
      }
      const checkout = await card.processor.createCheckout({
        accountId,
        amountCents: amountUsd * 100,
        returnUrl: `${baseUrl}/console`,
      });
      json(res, 201, { topUpId: checkout.id, checkoutUrl: checkout.url });
      return true;
    }
    const topUp = /^GET \/account\/topups\/([A-Za-z0-9_]{8,260})$/.exec(route);
    if (topUp) {
      if (!card) return json(res, 503, { error: "card_payments_unavailable" }), true;
      const status = await card.processor.getCheckout(topUp[1]!);
      // A checkout can only ever credit the account it was opened for. Until the processor can say
      // whose it is, it is simply pending.
      if (status.accountId !== null && status.accountId !== accountId) return json(res, 404, { error: "top_up_not_found" }), true;
      const paid = status.paid && status.accountId === accountId && status.amountCents > 0;
      if (paid) accounts.credit(accountId, status.amountCents * 10_000, `card:${topUp[1]}`);
      json(res, 200, { status: paid ? "paid" : "pending", creditMicroUsd: accounts.available(accountId) });
      return true;
    }
    return false;
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = `${req.method} ${path}`;
    Promise.resolve()
      .then(() => {
        if (route === "GET /health") {
          return json(res, 200, {
            ok: true,
            workers: hub.workers().length,
            network: gate.network,
            // On a test network hosts are paid in tokens with no value. The console says so wherever real money is asked for.
            testnet: !MAINNETS.has(gate.network),
            cardPayments: Boolean(card),
          });
        }
        if (route === "GET /workers") return json(res, 200, { workers: hub.workers().map(publicWorker) });
        const one = /^GET \/workers\/([0-9a-f]{16})$/.exec(route);
        if (one) {
          const worker = hub.worker(one[1]!);
          return worker ? json(res, 200, publicWorker(worker)) : json(res, 404, { error: "worker_not_found" });
        }
        if (route === "POST /tasks") return createTask(req, res);
        if (req.method === "GET" && Object.hasOwn(consoleFiles, path)) {
          const file = consoleFiles[path]!;
          res.writeHead(200, {
            "content-type": file.type,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "content-security-policy":
              "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          });
          return res.end(file.body);
        }
        return accountRoutes(route, req, res).then((handled) => {
          if (!handled) json(res, 404, { error: "not_found" });
        });
      })
      .catch((error) => {
        if (res.headersSent) return res.end();
        if (error instanceof Unauthorized) return json(res, 401, { error: "invalid_api_key" });
        if (error instanceof CardProcessorError) return json(res, 502, { error: "card_processor_error", message: error.message });
        json(res, 500, { error: "internal_error" });
      });
  });

  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/hosts/connect") return socket.destroy();
    hub.handleUpgrade(request, socket, head);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  baseUrl ||= url;

  return {
    url,
    hostUrl: `ws://127.0.0.1:${port}/hosts/connect`,
    tasks: () => tasks,
    accounts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        hub.close();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
