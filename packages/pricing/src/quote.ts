import type { MicroUsd } from "./money.ts";
import type { HourlyOffer, Offer } from "./products.ts";

/** Platform fee in basis points. 1000 = 10%. */
export const DEFAULT_FEE_BPS = 1000;

export interface Quote {
  /** What the renter pays. */
  gross: MicroUsd;
  /** What the platform keeps. */
  fee: MicroUsd;
  /** What the host earns. Always exactly gross minus fee. */
  host: MicroUsd;
  quantity: number;
  unit: "minute" | "session" | "call" | "term";
}

export type Usage =
  | { seconds: number }
  | { sessions: number }
  | { calls: number }
  | { terms: number };

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a whole number of zero or more`);
  return value;
}

/** Splits an amount into platform fee and host earnings. The fee rounds down, so the host never loses the odd unit. */
export function split(gross: MicroUsd, feeBps: number = DEFAULT_FEE_BPS): Pick<Quote, "gross" | "fee" | "host"> {
  count(gross, "amount");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 5000) throw new RangeError("fee must be between 0 and 5000 basis points");
  const fee = Math.floor((gross * feeBps) / 10_000);
  return { gross, fee, host: gross - fee };
}

/** Minutes charged for a session of `seconds`: every started minute counts, and the offer's minimum applies. */
export function billableMinutes(offer: HourlyOffer, seconds: number): number {
  count(seconds, "seconds");
  if (seconds === 0) return 0;
  return Math.min(offer.maxSessionMinutes, Math.max(offer.minimumMinutes, Math.ceil(seconds / 60)));
}

/** Price of `minutes` at the offer's hourly rate, rounded up to a whole micro-dollar. */
export function priceOfMinutes(offer: HourlyOffer, minutes: number): MicroUsd {
  return Math.ceil((offer.pricePerHour * count(minutes, "minutes")) / 60);
}

/** Whole minutes that `paid` buys at the offer's hourly rate. Never rounds in the renter's favour. */
export function minutesCovered(offer: HourlyOffer, paid: MicroUsd): number {
  count(paid, "amount");
  let minutes = Math.floor((paid * 60) / offer.pricePerHour);
  while (minutes > 0 && priceOfMinutes(offer, minutes) > paid) minutes--;
  return minutes;
}

/** What a given amount of use costs under an offer, and how it is split. */
export function quote(offer: Offer, usage: Usage, feeBps: number = DEFAULT_FEE_BPS): Quote {
  switch (offer.kind) {
    case "browser_node":
    case "regional_browser": {
      if (!("seconds" in usage)) throw new TypeError(`${offer.kind} is billed by time`);
      const minutes = billableMinutes(offer, usage.seconds);
      return { ...split(priceOfMinutes(offer, minutes), feeBps), quantity: minutes, unit: "minute" };
    }
    case "automation_session": {
      if (!("sessions" in usage)) throw new TypeError("automation_session is billed per session");
      const sessions = count(usage.sessions, "sessions");
      return { ...split(offer.pricePerSession * sessions, feeBps), quantity: sessions, unit: "session" };
    }
    case "agent_api": {
      if (!("calls" in usage)) throw new TypeError("agent_api is billed per call");
      const calls = count(usage.calls, "calls");
      return { ...split(offer.pricePerCall * calls, feeBps), quantity: calls, unit: "call" };
    }
    case "dedicated_node": {
      if (!("terms" in usage)) throw new TypeError("dedicated_node is billed per term");
      const terms = count(usage.terms, "terms");
      return { ...split(offer.pricePerMonth * terms, feeBps), quantity: terms, unit: "term" };
    }
  }
}
