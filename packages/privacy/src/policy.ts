import { z } from "zod";
import { canonicalJson, sha256Hex, type CapabilitySpec } from "@agentbnb/protocol";

/**
 * The host's rules. Default deny: a capability that is not listed is off, and
 * a field that is not listed is never returned.
 */
export const hostPolicySchema = z
  .object({
    capabilities: z.record(
      z
        .object({
          enabled: z.boolean(),
          allowFields: z.array(z.string().min(1).max(40)).max(50),
        })
        .strict(),
    ),
    maxTasksPerMinute: z.number().int().min(1).max(600).default(30),
  })
  .strict();
export type HostPolicy = z.infer<typeof hostPolicySchema>;

export class PolicyError extends Error {}

/** Parses a policy and refuses one that tries to enable something that can never be enabled. */
export function parsePolicy(raw: unknown, registry: Readonly<Record<string, CapabilitySpec>>): HostPolicy {
  const parsed = hostPolicySchema.safeParse(raw);
  if (!parsed.success) throw new PolicyError(`policy is not well formed: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  for (const [id, rule] of Object.entries(parsed.data.capabilities)) {
    const spec = registry[id];
    if (!spec) throw new PolicyError(`policy names an unknown capability: ${id}`);
    for (const field of rule.allowFields) {
      const fieldSpec = spec.fields[field];
      if (!fieldSpec) throw new PolicyError(`policy allows an unknown field: ${id}.${field}`);
      if (fieldSpec.sensitivity === "blocked") {
        throw new PolicyError(`${id}.${field} is always blocked and cannot be allowed`);
      }
    }
  }
  return parsed.data;
}

export function policyHash(policy: HostPolicy): string {
  return sha256Hex(canonicalJson(policy));
}

/** A starting policy: every capability on, with only its standard fields allowed. */
export function defaultPolicy(registry: Readonly<Record<string, CapabilitySpec>>): HostPolicy {
  const capabilities: HostPolicy["capabilities"] = {};
  for (const spec of Object.values(registry)) {
    capabilities[spec.id] = {
      enabled: true,
      allowFields: Object.entries(spec.fields)
        .filter(([, field]) => field.sensitivity === "standard")
        .map(([name]) => name),
    };
  }
  return { capabilities, maxTasksPerMinute: 30 };
}
