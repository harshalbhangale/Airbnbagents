import { z } from "zod";

export type FieldSensitivity =
  /** Returned when the host allows it. */
  | "standard"
  /** Off unless the host turns it on. */
  | "sensitive"
  /** Never returned. A host policy cannot enable it. */
  | "blocked";

export interface FieldSpec {
  label: string;
  sensitivity: FieldSensitivity;
  /** Shape the extracted value must have. Anything else rejects the whole result. */
  schema: z.ZodTypeAny;
  /** Output-scan detectors that do not apply to this field (an email field may hold an email). */
  exemptDetectors?: readonly string[];
}

export interface CapabilitySpec {
  id: string;
  title: string;
  description: string;
  /** Strict schema: unknown keys are rejected, so there is no room for URLs, selectors or scripts. */
  input: z.ZodType<Record<string, unknown>>;
  fields: Readonly<Record<string, FieldSpec>>;
}

const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\r\n\t]*$/, "single line only");

export const PROFILE_READ: CapabilitySpec = {
  id: "profile.read",
  title: "Read a member profile",
  description:
    "Returns structured fields from one member profile on the demo professional network, read through the host's signed-in session.",
  input: z
    .object({
      handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase handle"),
      fields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "field name")).min(1).max(20).optional(),
    })
    .strict(),
  fields: {
    name: { label: "Display name", sensitivity: "standard", schema: line(80) },
    headline: { label: "Job title", sensitivity: "standard", schema: line(120) },
    company: { label: "Company", sensitivity: "standard", schema: line(80) },
    about: { label: "About", sensitivity: "standard", schema: z.string().min(1).max(600) },
    location: { label: "Location", sensitivity: "sensitive", schema: line(80) },
    email: {
      label: "Email address",
      sensitivity: "sensitive",
      schema: z.string().email().max(120),
      exemptDetectors: ["email"],
    },
    messages: { label: "Private messages", sensitivity: "blocked", schema: z.never() },
    connections: { label: "Connections list", sensitivity: "blocked", schema: z.never() },
  },
};

export const CAPABILITIES: Readonly<Record<string, CapabilitySpec>> = {
  [PROFILE_READ.id]: PROFILE_READ,
};

/**
 * Whole categories that are never rentable, whatever a host or a future
 * capability author configures. A request for anything under these prefixes is
 * denied before any browser work happens.
 */
export const BLOCKED_CAPABILITY_PREFIXES = [
  "messages.",
  "inbox.",
  "contacts.",
  "credentials.",
  "cookies.",
  "session.",
  "settings.",
  "payments.",
  "browser.",
] as const;

export function isBlockedCapability(id: string): boolean {
  return BLOCKED_CAPABILITY_PREFIXES.some((prefix) => id.startsWith(prefix));
}
