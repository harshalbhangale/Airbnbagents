import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson, fromUtf8, toB64, utf8 } from "./bytes.ts";
import {
  generateEncryptionKeyPair,
  open,
  seal,
  sealedHash,
  verifySignature,
  type EncryptionKeyPair,
} from "./crypto.ts";

export const PROTOCOL_VERSION = 1;
const REQUEST_INFO = "agentbnb/v1/request";
const RESULT_INFO = "agentbnb/v1/result";

const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/);
const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/).max(64);
const keyIdSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** What travels through the marketplace. Everything outside `enc`/`ciphertext` is routing metadata. */
export const sealedRequestSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    taskId: taskIdSchema,
    capability: capabilityIdSchema,
    workerKeyId: keyIdSchema,
    enc: b64.max(128),
    ciphertext: b64.max(64_000),
  })
  .strict();
export type SealedRequest = z.infer<typeof sealedRequestSchema>;

/** Decrypted request. Only the worker ever sees this. */
export const requestBodySchema = z
  .object({
    input: z.record(z.unknown()),
    /** Agent's one-time public key; the result is encrypted to it. */
    replyTo: b64.length(43),
    issuedAt: z.number().int().positive(),
  })
  .strict();
export type RequestBody = z.infer<typeof requestBodySchema>;

export const STATUSES = ["ok", "denied", "rejected", "withheld", "error"] as const;
/**
 * ok        the task ran and approved fields were returned
 * denied    the host's rules or a fixed block said no; nothing ran
 * rejected  the request itself was invalid; nothing ran
 * withheld  the task ran but its output failed the outbound checks; nothing returned
 * error     the task could not be completed
 */
export type Status = (typeof STATUSES)[number];

export const REASONS = [
  "capability_blocked",
  "capability_disabled",
  "host_paused",
  "no_permitted_fields",
  "rate_limited",
  "undecryptable",
  "malformed",
  "expired",
  "replay",
  "unknown_capability",
  "invalid_input",
  "output_schema_violation",
  "output_scan_failed",
  "not_found",
  "not_signed_in",
  "timeout",
  "execution_failed",
] as const;
export type Reason = (typeof REASONS)[number];

export const WITHHELD_REASONS = ["host_policy", "always_blocked", "unknown_field", "not_present"] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

export const receiptSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    taskId: taskIdSchema,
    capability: capabilityIdSchema,
    status: z.enum(STATUSES),
    reason: z.enum(REASONS).nullable(),
    /** sha256 over the request ciphertext as received */
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** sha256 over the result ciphertext, when there is one */
    resultHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    policyHash: z.string().regex(/^[0-9a-f]{64}$/),
    workerKeyId: keyIdSchema,
    signingKey: b64.length(43),
    completedAt: z.number().int().positive(),
  })
  .strict();
export type Receipt = z.infer<typeof receiptSchema>;

export const sealedResultSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    taskId: taskIdSchema,
    capability: capabilityIdSchema,
    status: z.enum(STATUSES),
    reason: z.enum(REASONS).nullable(),
    enc: b64.max(128).nullable(),
    ciphertext: b64.max(256_000).nullable(),
    receipt: receiptSchema,
    signature: b64.max(128),
  })
  .strict();
export type SealedResult = z.infer<typeof sealedResultSchema>;

/** Decrypted result. Only the agent ever sees this. */
export const resultBodySchema = z
  .object({
    status: z.enum(STATUSES),
    reason: z.enum(REASONS).nullable(),
    data: z.record(z.unknown()).nullable(),
    withheld: z.array(z.object({ field: z.string(), reason: z.enum(WITHHELD_REASONS) }).strict()),
    /** Names of the outbound checks that fired, never the matched text. */
    detectors: z.array(z.string()),
  })
  .strict();
export type ResultBody = z.infer<typeof resultBodySchema>;

export function requestAad(meta: Pick<SealedRequest, "taskId" | "capability" | "workerKeyId">): string {
  return canonicalJson({
    v: PROTOCOL_VERSION,
    kind: "request",
    taskId: meta.taskId,
    capability: meta.capability,
    workerKeyId: meta.workerKeyId,
  });
}

export function resultAad(meta: Pick<SealedResult, "taskId" | "capability" | "status">): string {
  return canonicalJson({
    v: PROTOCOL_VERSION,
    kind: "result",
    taskId: meta.taskId,
    capability: meta.capability,
    status: meta.status,
  });
}

export const REQUEST_CONTEXT = { info: REQUEST_INFO } as const;
export const RESULT_CONTEXT = { info: RESULT_INFO } as const;

export function newTaskId(): string {
  return toB64(randomBytes(18));
}

export interface PreparedRequest {
  request: SealedRequest;
  /** Keep this to decrypt the result. It is used for one task only. */
  replyKeys: EncryptionKeyPair;
}

/** Agent side: encrypt a task so only the chosen worker can read it. */
export async function sealRequest(args: {
  capability: string;
  input: Record<string, unknown>;
  workerPublicKey: string;
  workerKeyId: string;
  taskId?: string;
  now?: number;
}): Promise<PreparedRequest> {
  const replyKeys = await generateEncryptionKeyPair();
  const taskId = args.taskId ?? newTaskId();
  const meta = { taskId, capability: args.capability, workerKeyId: args.workerKeyId };
  const body: RequestBody = {
    input: args.input,
    replyTo: replyKeys.publicKey,
    issuedAt: args.now ?? Date.now(),
  };
  const sealed = await seal(args.workerPublicKey, utf8(canonicalJson(body)), {
    info: REQUEST_INFO,
    aad: requestAad(meta),
  });
  return { request: { v: PROTOCOL_VERSION, ...meta, ...sealed }, replyKeys };
}

export class ResultVerificationError extends Error {}

/**
 * Agent side: check the worker's signed receipt, then decrypt the result.
 * Returns `body: null` when the worker could not address a reply (for example
 * it could not decrypt the request at all).
 */
export async function openResult(args: {
  result: unknown;
  request: SealedRequest;
  replyKeys: EncryptionKeyPair;
  /** The worker's signing key as published in its listing. */
  workerSigningKey: string;
}): Promise<{ status: Status; reason: Reason | null; receipt: Receipt; body: ResultBody | null }> {
  const parsed = sealedResultSchema.safeParse(args.result);
  if (!parsed.success) throw new ResultVerificationError("result is not well formed");
  const result = parsed.data;
  const { receipt } = result;

  if (receipt.signingKey !== args.workerSigningKey) throw new ResultVerificationError("receipt signed by an unexpected key");
  if (!verifySignature(receipt.signingKey, utf8(canonicalJson(receipt)), result.signature)) {
    throw new ResultVerificationError("receipt signature is invalid");
  }
  const { request } = args;
  if (result.taskId !== request.taskId || receipt.taskId !== request.taskId) {
    throw new ResultVerificationError("result is for a different task");
  }
  if (result.capability !== request.capability || receipt.capability !== request.capability) {
    throw new ResultVerificationError("result is for a different capability");
  }
  if (receipt.status !== result.status || receipt.reason !== result.reason) {
    throw new ResultVerificationError("result does not match its receipt");
  }
  if (receipt.requestHash !== sealedHash(request)) {
    throw new ResultVerificationError("receipt covers a different request");
  }

  if (result.enc === null || result.ciphertext === null) {
    if (receipt.resultHash !== null) throw new ResultVerificationError("receipt promises a result that is missing");
    return { status: result.status, reason: result.reason, receipt, body: null };
  }
  const sealed = { enc: result.enc, ciphertext: result.ciphertext };
  if (receipt.resultHash !== sealedHash(sealed)) {
    throw new ResultVerificationError("result ciphertext does not match its receipt");
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await open(args.replyKeys.privateKey, sealed, { info: RESULT_INFO, aad: resultAad(result) });
  } catch {
    throw new ResultVerificationError("result could not be decrypted");
  }
  const body = resultBodySchema.safeParse(JSON.parse(fromUtf8(plaintext)));
  if (!body.success) throw new ResultVerificationError("decrypted result is not well formed");
  if (body.data.status !== result.status || body.data.reason !== result.reason) {
    throw new ResultVerificationError("decrypted result disagrees with its envelope");
  }
  return { status: result.status, reason: result.reason, receipt, body: body.data };
}
