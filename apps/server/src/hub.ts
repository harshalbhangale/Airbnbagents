import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { canonicalJson, keyId, sha256Hex, utf8, verifySignature, type SealedRequest } from "@agentbnb/protocol";
import { parseOffers, type Offer } from "@agentbnb/pricing";

const b64Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const capabilityId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/).max(64);

/** A worker's listing is host-supplied text shown to agents, so its shape and sizes are checked strictly. */
const listingSchema = z
  .object({
    workerKeyId: z.string().regex(/^[0-9a-f]{16}$/),
    encryptionKey: b64Key,
    signingKey: b64Key,
    policyHash: z.string().regex(/^[0-9a-f]{64}$/),
    online: z.boolean(),
    capabilities: z
      .array(
        z
          .object({
            id: capabilityId,
            title: z.string().max(120),
            description: z.string().max(400),
            fields: z
              .array(
                z
                  .object({
                    name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
                    label: z.string().max(80),
                    available: z.boolean(),
                    alwaysBlocked: z.boolean(),
                  })
                  .strict(),
              )
              .max(60),
          })
          .strict(),
      )
      .max(50),
    offers: z.array(z.unknown()).max(50),
  })
  .strict();

const announceSchema = z
  .object({
    type: z.enum(["hello", "listing"]),
    listing: listingSchema,
    payoutAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
  })
  .strict();

export interface WorkerRecord {
  workerKeyId: string;
  encryptionKey: string;
  signingKey: string;
  policyHash: string;
  online: boolean;
  capabilities: z.infer<typeof listingSchema>["capabilities"];
  offers: Offer[];
  payoutAddress: string;
  connectedAt: number;
}

export class WorkerUnavailableError extends Error {}

interface Connection {
  socket: WebSocket;
  record: WorkerRecord;
  pending: Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
}

/**
 * Keeps the outbound connections that host workers open to the marketplace,
 * and passes tasks down them. It only ever handles ciphertext and metadata.
 */
export class WorkerHub {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  readonly #connections = new Map<string, Connection>();

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#accept(ws));
  }

  #accept(socket: WebSocket): void {
    const nonce = randomBytes(24).toString("base64url");
    let connection: Connection | null = null;
    const deadline = setTimeout(() => socket.close(), 10_000);
    socket.send(JSON.stringify({ type: "challenge", nonce }));

    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return socket.close();
      }
      const type = (message as { type?: unknown } | null)?.type;

      if (type === "hello" || type === "listing") {
        if ((type === "hello") === (connection !== null)) return socket.close();
        const record = this.#checkAnnouncement(message, nonce);
        if (!record || (connection && record.workerKeyId !== connection.record.workerKeyId)) {
          socket.send(JSON.stringify({ type: "refused" }));
          return socket.close();
        }
        if (connection) {
          connection.record = { ...record, connectedAt: connection.record.connectedAt };
          return;
        }
        clearTimeout(deadline);
        // A worker that reconnects replaces its old connection.
        this.#connections.get(record.workerKeyId)?.socket.close();
        connection = { socket, record, pending: new Map() };
        this.#connections.set(record.workerKeyId, connection);
        socket.send(JSON.stringify({ type: "welcome" }));
        return;
      }

      if (!connection) return socket.close();
      const id = (message as { id?: unknown }).id;
      const waiting = typeof id === "string" ? connection.pending.get(id) : undefined;
      if (!waiting || typeof id !== "string") return;
      connection.pending.delete(id);
      clearTimeout(waiting.timer);
      if (type === "result") waiting.resolve((message as { result?: unknown }).result);
      else waiting.reject(new WorkerUnavailableError("worker could not handle the task"));
    });

    socket.on("close", () => {
      clearTimeout(deadline);
      if (!connection) return;
      for (const waiting of connection.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new WorkerUnavailableError("worker disconnected"));
      }
      if (this.#connections.get(connection.record.workerKeyId) === connection) {
        this.#connections.delete(connection.record.workerKeyId);
      }
    });
    socket.on("error", () => socket.close());
  }

  /** Accepts a listing only if it is well formed and signed by the key it advertises. */
  #checkAnnouncement(message: unknown, nonce: string): WorkerRecord | null {
    const parsed = announceSchema.safeParse(message);
    if (!parsed.success) return null;
    const { listing, payoutAddress, signature } = parsed.data;
    if (keyId(listing.encryptionKey) !== listing.workerKeyId) return null;
    let offers: Offer[];
    try {
      offers = parseOffers(listing.offers);
    } catch {
      return null;
    }
    const raw = (message as { listing: unknown }).listing;
    const signed = `agentbnb/v1/host-auth\n${nonce}\n${sha256Hex(canonicalJson({ listing: raw, payoutAddress }))}`;
    if (!verifySignature(listing.signingKey, utf8(signed), signature)) return null;
    return { ...listing, offers, payoutAddress, connectedAt: Date.now() };
  }

  workers(): WorkerRecord[] {
    return [...this.#connections.values()].map((connection) => connection.record);
  }

  worker(workerKeyId: string): WorkerRecord | undefined {
    return this.#connections.get(workerKeyId)?.record;
  }

  /** Sends an encrypted task to a worker and waits for its answer. */
  dispatch(request: SealedRequest, timeoutMs = 45_000): Promise<unknown> {
    const connection = this.#connections.get(request.workerKeyId);
    if (!connection) return Promise.reject(new WorkerUnavailableError("worker is not connected"));
    const id = randomBytes(12).toString("base64url");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new WorkerUnavailableError("worker did not answer in time"));
      }, timeoutMs);
      connection.pending.set(id, { resolve, reject, timer });
      connection.socket.send(JSON.stringify({ type: "task", id, request }));
    });
  }

  /** Tells a worker that a payment to its payout address has settled. */
  notifySettled(workerKeyId: string, settlement: { network: string; transaction: string; amount: number; taskId: string }): void {
    this.#connections.get(workerKeyId)?.socket.send(JSON.stringify({ type: "settled", ...settlement }));
  }

  close(): void {
    for (const connection of this.#connections.values()) connection.socket.terminate();
    this.#wss.close();
  }
}
