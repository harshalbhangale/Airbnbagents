import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MicroUsd } from "./money.ts";
import { PRODUCT_KINDS, type ProductKind } from "./products.ts";
import type { Quote } from "./quote.ts";

/** One confirmed payment. `paymentId` is the settlement reference, so the same payment can never count twice. */
export interface Earning {
  paymentId: string;
  kind: ProductKind;
  gross: MicroUsd;
  fee: MicroUsd;
  host: MicroUsd;
  quantity: number;
  at: number;
}

export interface EarningsSummary {
  payments: number;
  gross: MicroUsd;
  fee: MicroUsd;
  host: MicroUsd;
  byKind: Record<ProductKind, { payments: number; host: MicroUsd }>;
}

/**
 * The host's record of money actually received. Entries are added only for
 * settled payments, never for work that was merely done or quoted.
 */
export class EarningsLedger {
  readonly #entries = new Map<string, Earning>();
  readonly #file: string | undefined;

  constructor(file?: string) {
    this.#file = file;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as Earning;
        this.#entries.set(entry.paymentId, entry);
      }
    } else if (file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    }
  }

  /** Records a settled payment. Returns false, and changes nothing, if this payment was already recorded. */
  record(paymentId: string, kind: ProductKind, quote: Quote, at: number): boolean {
    if (!/^[A-Za-z0-9_:.-]{8,128}$/.test(paymentId)) throw new RangeError("invalid payment reference");
    if (quote.gross !== quote.fee + quote.host || quote.gross <= 0) throw new RangeError("quote does not add up");
    if (this.#entries.has(paymentId)) return false;
    const entry: Earning = { paymentId, kind, gross: quote.gross, fee: quote.fee, host: quote.host, quantity: quote.quantity, at };
    this.#entries.set(paymentId, entry);
    if (this.#file) appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  }

  entries(): Earning[] {
    return [...this.#entries.values()];
  }

  summary(since = 0): EarningsSummary {
    const byKind = Object.fromEntries(PRODUCT_KINDS.map((kind) => [kind, { payments: 0, host: 0 }])) as EarningsSummary["byKind"];
    const total: EarningsSummary = { payments: 0, gross: 0, fee: 0, host: 0, byKind };
    for (const entry of this.#entries.values()) {
      if (entry.at < since) continue;
      total.payments++;
      total.gross += entry.gross;
      total.fee += entry.fee;
      total.host += entry.host;
      byKind[entry.kind].payments++;
      byKind[entry.kind].host += entry.host;
    }
    return total;
  }
}
