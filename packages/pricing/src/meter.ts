import type { MicroUsd } from "./money.ts";
import type { HourlyOffer } from "./products.ts";
import { DEFAULT_FEE_BPS, minutesCovered, priceOfMinutes, split, type Quote } from "./quote.ts";

/**
 * Meters an hourly session that is paid for in advance, one block at a time.
 * The renter pays for a block of minutes, the session runs until that time is
 * used up, and it stops unless another block has been paid. Neither side can
 * lose more than one block: the host never works unpaid, and the renter never
 * prepays more than the block they chose.
 */
export class SessionMeter {
  readonly #offer: HourlyOffer;
  readonly #feeBps: number;
  readonly #startedAt: number;
  #paid: MicroUsd = 0;
  #minutes = 0;
  #closedAt: number | null = null;

  constructor(offer: HourlyOffer, startedAt: number, feeBps: number = DEFAULT_FEE_BPS) {
    this.#offer = offer;
    this.#startedAt = startedAt;
    this.#feeBps = feeBps;
  }

  /** What the renter must pay to add `minutes`. The first block must meet the offer's minimum. */
  blockPrice(minutes: number): MicroUsd {
    if (!Number.isSafeInteger(minutes) || minutes < 1) throw new RangeError("a block is at least one minute");
    if (this.#minutes === 0 && minutes < this.#offer.minimumMinutes) {
      throw new RangeError(`the first block must be at least ${this.#offer.minimumMinutes} minutes`);
    }
    if (this.#minutes + minutes > this.#offer.maxSessionMinutes) {
      throw new RangeError(`this host limits a session to ${this.#offer.maxSessionMinutes} minutes`);
    }
    return priceOfMinutes(this.#offer, minutes);
  }

  /**
   * Records a confirmed payment and extends the session. Returns the minutes
   * added. A payment that arrives after the paid time ran out, or that does
   * not buy a whole minute, is refused.
   */
  addPayment(amount: MicroUsd, now: number): number {
    if (this.#closedAt !== null) throw new Error("session is closed");
    if (this.#minutes > 0 && now >= this.paidUntil) throw new Error("session already ran out of paid time");
    const minutes = minutesCovered(this.#offer, amount);
    if (minutes < 1) throw new RangeError("payment does not cover a whole minute");
    this.blockPrice(minutes);
    this.#paid += amount;
    this.#minutes += minutes;
    return minutes;
  }

  /** The moment the paid time runs out. */
  get paidUntil(): number {
    return this.#startedAt + this.#minutes * 60_000;
  }

  get paidMinutes(): number {
    return this.#minutes;
  }

  /** True while the session may keep running. */
  isActive(now: number): boolean {
    return this.#closedAt === null && this.#minutes > 0 && now < this.paidUntil;
  }

  secondsRemaining(now: number): number {
    if (!this.isActive(now)) return 0;
    return Math.ceil((this.paidUntil - now) / 1000);
  }

  /** Ends the session. Paid blocks are not refunded; the host earns what was paid, less the fee. */
  close(now: number): Quote {
    if (this.#closedAt === null) this.#closedAt = Math.min(now, Math.max(this.paidUntil, this.#startedAt));
    return { ...split(this.#paid, this.#feeBps), quantity: this.#minutes, unit: "minute" };
  }
}
