import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MicroUsd } from "./money.ts";
import { PRODUCT_KINDS, type ProductKind } from "./products.ts";
import type { Quote } from "./quote.ts";

/**
 * reported   the marketplace says this payment settled; not yet checked
 * confirmed  the transfer was found onchain, to the right address, for the right amount
 * failed     the transaction was checked and does not pay what was claimed; it counts for nothing
 */
export type EarningState = "reported" | "confirmed" | "failed";

/** One payment. `paymentId` is the settlement reference, so the same payment can never count twice. */
export interface Earning {
  paymentId: string;
  kind: ProductKind;
  gross: MicroUsd;
  fee: MicroUsd;
  host: MicroUsd;
  quantity: number;
  at: number;
  state: EarningState;
}

export interface EarningsSummary {
  /** Payments that count: confirmed plus those still awaiting a check. */
  payments: number;
  gross: MicroUsd;
  fee: MicroUsd;
  host: MicroUsd;
  /** The part of `host` that has been found onchain. */
  confirmed: { payments: number; host: MicroUsd };
  /** The part of `host` that is still only the marketplace's word. */
  awaiting: { payments: number; host: MicroUsd };
  byKind: Record<ProductKind, { payments: number; host: MicroUsd }>;
}

/**
 * The host's record of money received. An entry is added when a payment is
 * reported as settled, never for work that was merely done or quoted, and it
 * is marked confirmed only once the transfer has been checked onchain.
 */
export class EarningsLedger {
  readonly #entries = new Map<string, Earning>();
  readonly #file: string | undefined;

  constructor(file?: string) {
    this.#file = file;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as Earning | { update: string; state: EarningState };
        if ("update" in row) {
          const entry = this.#entries.get(row.update);
          if (entry) entry.state = row.state;
        } else {
          this.#entries.set(row.paymentId, { ...row, state: row.state ?? "reported" });
        }
      }
    } else if (file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    }
  }

  /** Records a reported payment. Returns false, and changes nothing, if this payment was already recorded. */
  record(paymentId: string, kind: ProductKind, quote: Quote, at: number, state: EarningState = "reported"): boolean {
    if (!/^[A-Za-z0-9_:.-]{8,128}$/.test(paymentId)) throw new RangeError("invalid payment reference");
    if (quote.gross !== quote.fee + quote.host || quote.gross <= 0) throw new RangeError("quote does not add up");
    if (this.#entries.has(paymentId)) return false;
    const entry: Earning = { paymentId, kind, gross: quote.gross, fee: quote.fee, host: quote.host, quantity: quote.quantity, at, state };
    this.#entries.set(paymentId, entry);
    if (this.#file) appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  }

  /** Marks a payment confirmed or failed after it has been checked. A confirmed payment never changes again. */
  resolve(paymentId: string, state: "confirmed" | "failed"): boolean {
    const entry = this.#entries.get(paymentId);
    if (!entry || entry.state === "confirmed" || entry.state === state) return false;
    entry.state = state;
    if (this.#file) appendFileSync(this.#file, `${JSON.stringify({ update: paymentId, state })}\n`, { mode: 0o600 });
    return true;
  }

  get(paymentId: string): Earning | undefined {
    const entry = this.#entries.get(paymentId);
    return entry ? { ...entry } : undefined;
  }

  /** Newest first. */
  entries(): Earning[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry })).sort((a, b) => b.at - a.at);
  }

  summary(since = 0): EarningsSummary {
    const byKind = Object.fromEntries(PRODUCT_KINDS.map((kind) => [kind, { payments: 0, host: 0 }])) as EarningsSummary["byKind"];
    const total: EarningsSummary = {
      payments: 0,
      gross: 0,
      fee: 0,
      host: 0,
      confirmed: { payments: 0, host: 0 },
      awaiting: { payments: 0, host: 0 },
      byKind,
    };
    for (const entry of this.#entries.values()) {
      if (entry.at < since || entry.state === "failed") continue;
      total.payments++;
      total.gross += entry.gross;
      total.fee += entry.fee;
      total.host += entry.host;
      const bucket = entry.state === "confirmed" ? total.confirmed : total.awaiting;
      bucket.payments++;
      bucket.host += entry.host;
      byKind[entry.kind].payments++;
      byKind[entry.kind].host += entry.host;
    }
    return total;
  }
}
