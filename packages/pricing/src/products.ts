import { z } from "zod";
import type { MicroUsd } from "./money.ts";

export const PRODUCT_KINDS = ["browser_node", "regional_browser", "automation_session", "agent_api", "dedicated_node"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export type Unit = "hour" | "session" | "call" | "month";

export const PRODUCTS: Readonly<Record<ProductKind, { title: string; unit: Unit; summary: string }>> = {
  browser_node: {
    title: "Browser node",
    unit: "hour",
    summary: "A clean browser on a host's device, rented by the hour and billed by the minute.",
  },
  regional_browser: {
    title: "Regional browser",
    unit: "hour",
    summary: "A browser node in a named country, for work that has to run from that region.",
  },
  automation_session: {
    title: "Automation session",
    unit: "session",
    summary: "One run of a fixed capability, charged per completed session.",
  },
  agent_api: {
    title: "Agent API",
    unit: "call",
    summary: "Programmatic access for agents, charged per call.",
  },
  dedicated_node: {
    title: "Dedicated node",
    unit: "month",
    summary: "A device reserved for one renter for a fixed term.",
  },
};

/** $0.000001 to $100,000 per unit. */
const price = z.number().int().min(1).max(100_000_000_000);
const hourly = {
  pricePerHour: price,
  /** Shortest billable session. */
  minimumMinutes: z.number().int().min(1).max(60).default(1),
  /** The host can cap how long one session may run. */
  maxSessionMinutes: z.number().int().min(1).max(24 * 60).default(240),
};

export const offerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("browser_node"), ...hourly }).strict(),
  z
    .object({
      kind: z.literal("regional_browser"),
      /** ISO 3166-1 alpha-2 country code, upper case. */
      region: z.string().regex(/^[A-Z]{2}$/),
      ...hourly,
    })
    .strict(),
  z
    .object({
      kind: z.literal("automation_session"),
      capability: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/).max(64),
      pricePerSession: price,
    })
    .strict(),
  z.object({ kind: z.literal("agent_api"), pricePerCall: price }).strict(),
  z
    .object({
      kind: z.literal("dedicated_node"),
      pricePerMonth: price,
      termDays: z.number().int().min(1).max(365).default(30),
    })
    .strict(),
]);
export type Offer = z.infer<typeof offerSchema>;
export type HourlyOffer = Extract<Offer, { kind: "browser_node" | "regional_browser" }>;

export const offersSchema = z.array(offerSchema).max(50);

export class OfferError extends Error {}

/** Stable identity for an offer, so a host cannot list the same thing twice at two prices. */
export function offerKey(offer: Offer): string {
  switch (offer.kind) {
    case "regional_browser":
      return `${offer.kind}:${offer.region}`;
    case "automation_session":
      return `${offer.kind}:${offer.capability}`;
    default:
      return offer.kind;
  }
}

export function parseOffers(raw: unknown): Offer[] {
  const parsed = offersSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OfferError(`offers are not valid: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid"}`);
  }
  const seen = new Set<string>();
  for (const offer of parsed.data) {
    const key = offerKey(offer);
    if (seen.has(key)) throw new OfferError(`duplicate offer: ${key}`);
    seen.add(key);
  }
  return parsed.data;
}

export function unitPrice(offer: Offer): { amount: MicroUsd; unit: Unit } {
  switch (offer.kind) {
    case "browser_node":
    case "regional_browser":
      return { amount: offer.pricePerHour, unit: "hour" };
    case "automation_session":
      return { amount: offer.pricePerSession, unit: "session" };
    case "agent_api":
      return { amount: offer.pricePerCall, unit: "call" };
    case "dedicated_node":
      return { amount: offer.pricePerMonth, unit: "month" };
  }
}
