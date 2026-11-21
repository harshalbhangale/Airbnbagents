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
import { WorkerHub, WorkerUnavailableError, type WorkerRecord } from "./hub.ts";
import { PaymentError, PaymentGate, type Challenge, type PaymentConfig, type VerifiedPayment } from "./payments.ts";

export interface MarketplaceOptions extends PaymentConfig {
  port?: number;
  /** Public address of this server, used in payment requests. Defaults to the local address. */
  publicUrl?: string;
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
  at: number;
}

export interface Marketplace {
  url: string;
  /** ws:// address host workers connect to. */
  hostUrl: string;
  tasks(): readonly TaskRecord[];
  close(): Promise<void>;
}

const MAX_BODY = 300_000;

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

    let challenge: Challenge | null = null;
    let payment: VerifiedPayment | null = null;
    if (price !== null) {
      const resource = { url: `${baseUrl}/tasks`, description: `${request.capability} on worker ${worker.workerKeyId}` };
      challenge = await gate.challenge(price, worker.payoutAddress, resource);
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
        const reason = error instanceof PaymentError ? error.message : "settlement failed";
        const retry = await gate.challenge(price!, worker.payoutAddress, { url: `${baseUrl}/tasks`, description: request.capability }, reason);
        return json(res, 402, retry.body, { "PAYMENT-REQUIRED": retry.header });
      }
      record(request, { status: "ok", priceMicroUsd: price, transaction: settlement.transaction });
      hub.notifySettled(worker.workerKeyId, {
        network: settlement.network,
        transaction: settlement.transaction,
        amount: settlement.amount,
        taskId: request.taskId,
      });
      return json(
        res,
        200,
        { result, payment: { transaction: settlement.transaction, network: settlement.network, amount: settlement.amount, payTo: worker.payoutAddress } },
        { "PAYMENT-RESPONSE": settlement.header },
      );
    } finally {
      if (payment) inFlightPayments.delete(payment.key);
    }
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = `${req.method} ${path}`;
    Promise.resolve()
      .then(() => {
        if (route === "GET /health") return json(res, 200, { ok: true, workers: hub.workers().length, network: gate.network });
        if (route === "GET /workers") return json(res, 200, { workers: hub.workers().map(publicWorker) });
        const one = /^GET \/workers\/([0-9a-f]{16})$/.exec(route);
        if (one) {
          const worker = hub.worker(one[1]!);
          return worker ? json(res, 200, publicWorker(worker)) : json(res, 404, { error: "worker_not_found" });
        }
        if (route === "POST /tasks") return createTask(req, res);
        return json(res, 404, { error: "not_found" });
      })
      .catch(() => {
        if (!res.headersSent) json(res, 500, { error: "internal_error" });
        else res.end();
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        hub.close();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
