import { canonicalJson, sha256Hex } from "@agentbnb/protocol";
import { MalformedEnvelopeError, type SealedOutput } from "@agentbnb/privacy";
import type { HostWorker } from "./worker.ts";

export interface MarketplaceLinkOptions {
  /** ws:// or wss:// address of the marketplace's host endpoint. */
  url: string;
  /** Where the host is paid, as an EVM address. */
  payoutAddress: string;
  onStatus?: (status: "connected" | "disconnected" | "refused") => void;
}

export interface MarketplaceLink {
  /** Resolves once the marketplace has accepted this worker. */
  ready: Promise<void>;
  /** Re-announces the listing after the host changed rules or prices. */
  refresh(): void;
  close(): void;
}

/**
 * Dials out to the marketplace, so the host needs no open ports. Tasks arrive
 * over this connection, and the only thing ever sent back for a task is a
 * `SealedOutput` from the privacy layer.
 */
export function connectToMarketplace(worker: HostWorker, options: MarketplaceLinkOptions): MarketplaceLink {
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.payoutAddress)) throw new RangeError("payout address must be an EVM address");
  let socket: WebSocket | null = null;
  let closed = false;
  let nonce = "";
  let attempt = 0;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);

  const announce = (type: "hello" | "listing") => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !nonce) return;
    const listing = worker.listing();
    const payoutAddress = options.payoutAddress;
    const signature = worker.signMarketplaceAuth(nonce, sha256Hex(canonicalJson({ listing, payoutAddress })));
    socket.send(JSON.stringify({ type, listing, payoutAddress, signature }));
  };

  const sendResult = (id: string, output: SealedOutput) => {
    socket?.send(JSON.stringify({ type: "result", id, result: output.wire }));
  };

  const open = () => {
    if (closed) return;
    const ws = new WebSocket(options.url);
    socket = ws;
    nonce = "";
    ws.addEventListener("message", (event) => {
      let message: { type?: unknown; [key: string]: unknown };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "challenge" && typeof message.nonce === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(message.nonce)) {
        nonce = message.nonce;
        announce("hello");
      } else if (message.type === "welcome") {
        attempt = 0;
        options.onStatus?.("connected");
        resolveReady();
      } else if (message.type === "refused") {
        options.onStatus?.("refused");
        rejectReady(new Error("marketplace refused this worker"));
        closed = true;
        ws.close();
      } else if (message.type === "task" && typeof message.id === "string") {
        const id = message.id;
        worker.handle(message.request).then(
          (output) => sendResult(id, output),
          (error) => {
            const reason = error instanceof MalformedEnvelopeError ? "malformed" : "failed";
            socket?.send(JSON.stringify({ type: "error", id, reason }));
          },
        );
      } else if (message.type === "settled") {
        const { network, transaction, amount } = message;
        if (
          typeof network === "string" && /^[a-z0-9]+:[A-Za-z0-9]+$/.test(network) &&
          typeof transaction === "string" && /^0x[0-9a-f]{64}$/.test(transaction) &&
          typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0
        ) {
          worker.recordSettlement({ network, transaction, amount, at: Date.now() });
        }
      }
    });
    ws.addEventListener("close", () => {
      if (socket === ws) socket = null;
      if (closed) return;
      options.onStatus?.("disconnected");
      const delay = Math.min(30_000, 500 * 2 ** attempt++);
      setTimeout(open, delay).unref?.();
    });
    ws.addEventListener("error", () => undefined);
  };
  open();

  return {
    ready,
    refresh: () => announce("listing"),
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}
