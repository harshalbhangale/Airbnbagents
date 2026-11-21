import {
  PROTOCOL_VERSION,
  REQUEST_CONTEXT,
  RESULT_CONTEXT,
  canonicalJson,
  fromUtf8,
  isBlockedCapability,
  open,
  requestAad,
  requestBodySchema,
  resultAad,
  seal,
  sealedHash,
  sealedRequestSchema,
  utf8,
  type CapabilitySpec,
  type Reason,
  type Receipt,
  type ResultBody,
  type SealedRequest,
  type SealedResult,
  type Status,
  type WithheldReason,
} from "@agentbnb/protocol";
import type { AuditLog } from "./audit.ts";
import type { WorkerKeys } from "./keys.ts";
import { parsePolicy, policyHash, type HostPolicy } from "./policy.ts";
import { scanText } from "./scan.ts";

/** A failure the task code is allowed to name. Anything else is reported as a generic failure. */
export class ExecutorError extends Error {
  constructor(readonly code: "not_found" | "not_signed_in" | "timeout") {
    super(code);
  }
}

/**
 * The code that actually does the work for one capability. It is told which
 * fields it may read and must not read any others; the layer checks anyway.
 */
export type Executor = (args: {
  input: Readonly<Record<string, unknown>>;
  fields: readonly string[];
  signal: AbortSignal;
}) => Promise<unknown>;

/** Thrown when the outer envelope is so broken there is no task to answer. */
export class MalformedEnvelopeError extends Error {}

const MINT = Symbol("sealed-output");

/**
 * The only thing the worker's network code accepts for sending. It can be
 * created by the privacy layer and nowhere else, so every byte that leaves the
 * host's machine has been through the allowlist, the scan and encryption.
 */
export class SealedOutput {
  readonly wire: Readonly<SealedResult>;
  constructor(token: symbol, wire: SealedResult) {
    if (token !== MINT) throw new Error("SealedOutput can only be created by the privacy layer");
    this.wire = Object.freeze(wire);
  }
}

export interface PrivacyLayerOptions {
  keys: WorkerKeys;
  policy: unknown;
  registry: Readonly<Record<string, CapabilitySpec>>;
  executors: Readonly<Record<string, Executor>>;
  audit: AuditLog;
  now?: () => number;
  /** How far a request's timestamp may be from the worker's clock. */
  maxClockSkewMs?: number;
  taskTimeoutMs?: number;
}

export interface Listing {
  workerKeyId: string;
  encryptionKey: string;
  signingKey: string;
  policyHash: string;
  online: boolean;
  capabilities: {
    id: string;
    title: string;
    description: string;
    priceCents: number;
    fields: { name: string; label: string; available: boolean; alwaysBlocked: boolean }[];
  }[];
}

interface Outcome {
  status: Status;
  reason: Reason | null;
  replyTo?: string;
  data?: Record<string, unknown> | null;
  withheld?: { field: string; reason: WithheldReason }[];
  detectors?: string[];
  droppedKeys?: number;
}

const EXECUTOR_REASONS: ReadonlySet<string> = new Set(["not_found", "not_signed_in", "timeout"]);

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out);
    }
  }
}

export class PrivacyLayer {
  readonly #keys: WorkerKeys;
  readonly #registry: Readonly<Record<string, CapabilitySpec>>;
  readonly #executors: Readonly<Record<string, Executor>>;
  readonly #audit: AuditLog;
  readonly #now: () => number;
  readonly #skew: number;
  readonly #timeout: number;
  #policy: HostPolicy;
  #policyHash: string;
  #paused = false;
  readonly #seen = new Map<string, number>();
  #recent: number[] = [];

  constructor(options: PrivacyLayerOptions) {
    this.#keys = options.keys;
    this.#registry = options.registry;
    this.#executors = options.executors;
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
    this.#skew = options.maxClockSkewMs ?? 5 * 60_000;
    this.#timeout = options.taskTimeoutMs ?? 30_000;
    this.#policy = parsePolicy(options.policy, this.#registry);
    this.#policyHash = policyHash(this.#policy);
  }

  get policy(): HostPolicy {
    return structuredClone(this.#policy);
  }

  /** Replaces the host's rules. Throws, and keeps the old rules, if the new ones are invalid. */
  setPolicy(raw: unknown): void {
    const next = parsePolicy(raw, this.#registry);
    this.#policy = next;
    this.#policyHash = policyHash(next);
  }

  /** Kill switch: every task is denied until `resume()`. */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** What the worker advertises. Contains public keys and the offer, nothing private. */
  listing(): Listing {
    const capabilities: Listing["capabilities"] = [];
    for (const spec of Object.values(this.#registry)) {
      const rule = this.#policy.capabilities[spec.id];
      if (!rule?.enabled || !this.#executors[spec.id]) continue;
      capabilities.push({
        id: spec.id,
        title: spec.title,
        description: spec.description,
        priceCents: spec.priceCents,
        fields: Object.entries(spec.fields).map(([name, field]) => ({
          name,
          label: field.label,
          available: field.sensitivity !== "blocked" && rule.allowFields.includes(name),
          alwaysBlocked: field.sensitivity === "blocked",
        })),
      });
    }
    return {
      workerKeyId: this.#keys.keyId,
      encryptionKey: this.#keys.encryptionPublicKey,
      signingKey: this.#keys.signingPublicKey,
      policyHash: this.#policyHash,
      online: !this.#paused,
      capabilities,
    };
  }

  /**
   * Takes one encrypted task and returns one encrypted answer. Never throws
   * for a bad task: every refusal is itself a signed, logged result. The only
   * exception is an envelope too broken to identify a task.
   */
  async handle(raw: unknown): Promise<SealedOutput> {
    const started = this.#now();
    const parsed = sealedRequestSchema.safeParse(raw);
    if (!parsed.success) throw new MalformedEnvelopeError("request envelope is not well formed");
    const request = parsed.data;
    const outcome = await this.#decide(request);
    return this.#finish(request, outcome, started);
  }

  async #decide(request: SealedRequest): Promise<Outcome> {
    if (this.#paused) return { status: "denied", reason: "host_paused" };
    if (request.workerKeyId !== this.#keys.keyId) return { status: "rejected", reason: "undecryptable" };

    // Fixed blocks come first: no decryption, no browser, nothing to get wrong.
    if (isBlockedCapability(request.capability)) return { status: "denied", reason: "capability_blocked" };
    const spec = this.#registry[request.capability];
    const executor = this.#executors[request.capability];
    if (!spec || !executor) return { status: "rejected", reason: "unknown_capability" };
    const rule = this.#policy.capabilities[spec.id];
    if (!rule?.enabled) return { status: "denied", reason: "capability_disabled" };
    if (!this.#takeRateSlot()) return { status: "denied", reason: "rate_limited" };

    // Inbound: decrypt, then validate everything before any work happens.
    let plaintext: Uint8Array;
    try {
      plaintext = await open(this.#keys.encryptionPrivateKey, request, {
        info: REQUEST_CONTEXT.info,
        aad: requestAad(request),
      });
    } catch {
      return { status: "rejected", reason: "undecryptable" };
    }
    let body;
    try {
      body = requestBodySchema.parse(JSON.parse(fromUtf8(plaintext)));
    } catch {
      return { status: "rejected", reason: "malformed" };
    }
    const replyTo = body.replyTo;
    const now = this.#now();
    if (Math.abs(now - body.issuedAt) > this.#skew) return { status: "rejected", reason: "expired", replyTo };
    if (this.#isReplay(request.taskId, now)) return { status: "rejected", reason: "replay", replyTo };

    const input = spec.input.safeParse(body.input);
    if (!input.success) return { status: "rejected", reason: "invalid_input", replyTo };
    const { fields: requestedRaw, ...taskInput } = input.data as { fields?: string[] } & Record<string, unknown>;

    const requested = [
      ...new Set(
        requestedRaw ??
          Object.entries(spec.fields)
            .filter(([, field]) => field.sensitivity !== "blocked")
            .map(([name]) => name),
      ),
    ];
    const allowed: string[] = [];
    const withheld: { field: string; reason: WithheldReason }[] = [];
    for (const field of requested) {
      const fieldSpec = Object.hasOwn(spec.fields, field) ? spec.fields[field] : undefined;
      if (!fieldSpec) withheld.push({ field: field.slice(0, 40), reason: "unknown_field" });
      else if (fieldSpec.sensitivity === "blocked") withheld.push({ field, reason: "always_blocked" });
      else if (!rule.allowFields.includes(field)) withheld.push({ field, reason: "host_policy" });
      else allowed.push(field);
    }
    if (allowed.length === 0) return { status: "denied", reason: "no_permitted_fields", replyTo, withheld };

    // Run the task, telling it exactly which fields it may read.
    let produced: unknown;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      produced = await Promise.race([
        executor({ input: Object.freeze({ ...taskInput }), fields: Object.freeze([...allowed]), signal: controller.signal }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new ExecutorError("timeout")), { once: true });
        }),
      ]);
    } catch (error) {
      const reason: Reason =
        error instanceof ExecutorError && EXECUTOR_REASONS.has(error.code) ? error.code : "execution_failed";
      return { status: "error", reason, replyTo, withheld };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }

    // Outbound, step 1: rebuild the result from the allowlist. Whatever else the task produced is dropped.
    if (produced === null || typeof produced !== "object" || Array.isArray(produced)) {
      return { status: "withheld", reason: "output_schema_violation", replyTo, withheld };
    }
    const source = produced as Record<string, unknown>;
    const droppedKeys = Object.keys(source).filter((key) => !allowed.includes(key)).length;
    const data: Record<string, unknown> = {};
    for (const field of allowed) {
      let value = Object.hasOwn(source, field) ? source[field] : undefined;
      if (typeof value === "string") value = value.normalize("NFKC").trim();
      if (value === undefined || value === null || value === "") {
        withheld.push({ field, reason: "not_present" });
        continue;
      }
      const checked = spec.fields[field]!.schema.safeParse(value);
      if (!checked.success) {
        return { status: "withheld", reason: "output_schema_violation", replyTo, withheld, droppedKeys, detectors: [`${field}:schema`] };
      }
      data[field] = checked.data;
    }

    // Outbound, step 2: scan what is left. One hit throws the whole result away.
    const detectors: string[] = [];
    for (const [field, value] of Object.entries(data)) {
      const strings: string[] = [];
      collectStrings(value, strings);
      const hits = new Set<string>();
      for (const text of strings) for (const hit of scanText(text, spec.fields[field]!.exemptDetectors)) hits.add(hit);
      for (const hit of [...hits].sort()) detectors.push(`${field}:${hit}`);
    }
    if (detectors.length > 0) {
      return { status: "withheld", reason: "output_scan_failed", replyTo, withheld, droppedKeys, detectors };
    }

    return { status: "ok", reason: null, replyTo, data, withheld, droppedKeys };
  }

  /** Outbound, step 3: encrypt to the agent, sign the receipt, write the audit line. */
  async #finish(request: SealedRequest, outcome: Outcome, started: number): Promise<SealedOutput> {
    let { status, reason } = outcome;
    const meta = { taskId: request.taskId, capability: request.capability };
    let sealed: { enc: string; ciphertext: string } | null = null;

    if (outcome.replyTo) {
      const body: ResultBody = {
        status,
        reason,
        data: status === "ok" ? (outcome.data ?? {}) : null,
        withheld: outcome.withheld ?? [],
        detectors: outcome.detectors ?? [],
      };
      try {
        sealed = await seal(outcome.replyTo, utf8(canonicalJson(body)), {
          info: RESULT_CONTEXT.info,
          aad: resultAad({ ...meta, status }),
        });
      } catch {
        // The reply key was unusable, so there is nobody to send the answer to.
        status = "rejected";
        reason = "malformed";
        sealed = null;
      }
    }

    const completedAt = this.#now();
    const requestHash = sealedHash(request);
    const resultHash = sealed ? sealedHash(sealed) : null;
    const receipt: Receipt = {
      v: PROTOCOL_VERSION,
      ...meta,
      status,
      reason,
      requestHash,
      resultHash,
      policyHash: this.#policyHash,
      workerKeyId: this.#keys.keyId,
      signingKey: this.#keys.signingPublicKey,
      completedAt,
    };
    const signature = this.#keys.sign(utf8(canonicalJson(receipt)));

    this.#audit.append(
      {
        ...meta,
        status,
        reason,
        fieldsReturned: status === "ok" && sealed ? Object.keys(outcome.data ?? {}) : [],
        fieldsWithheld: (outcome.withheld ?? []).map((w) => w.field),
        detectors: outcome.detectors ?? [],
        droppedKeys: outcome.droppedKeys ?? 0,
        requestHash,
        resultHash,
        durationMs: Math.max(0, completedAt - started),
      },
      completedAt,
    );

    return new SealedOutput(MINT, {
      v: PROTOCOL_VERSION,
      ...meta,
      status,
      reason,
      enc: sealed?.enc ?? null,
      ciphertext: sealed?.ciphertext ?? null,
      receipt,
      signature,
    });
  }

  #takeRateSlot(): boolean {
    const now = this.#now();
    this.#recent = this.#recent.filter((at) => now - at < 60_000);
    if (this.#recent.length >= this.#policy.maxTasksPerMinute) return false;
    this.#recent.push(now);
    return true;
  }

  #isReplay(taskId: string, now: number): boolean {
    for (const [id, expires] of this.#seen) if (expires <= now) this.#seen.delete(id);
    if (this.#seen.has(taskId)) return true;
    // Remembered for longer than a request can stay valid, so an old copy is caught by one check or the other.
    this.#seen.set(taskId, now + 2 * this.#skew + 1_000);
    return false;
  }
}
