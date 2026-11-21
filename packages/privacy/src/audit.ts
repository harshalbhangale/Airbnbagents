import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256Hex, type Reason, type Status } from "@agentbnb/protocol";

/**
 * What the host can review afterwards. Holds decisions and hashes only: no
 * task input, no extracted values, no matched text.
 */
export interface AuditEvent {
  taskId: string;
  capability: string;
  status: Status;
  reason: Reason | null;
  fieldsReturned: string[];
  fieldsWithheld: string[];
  /** Output checks that fired. */
  detectors: string[];
  /** Keys the task produced that were not on the allowlist and were dropped. */
  droppedKeys: number;
  requestHash: string;
  resultHash: string | null;
  durationMs: number;
}

export interface AuditEntry extends AuditEvent {
  seq: number;
  at: number;
  /** Hash of the previous entry, so a removed or edited line is detectable. */
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function entryHash(entry: Omit<AuditEntry, "hash">): string {
  return sha256Hex(canonicalJson(entry));
}

export class AuditLog {
  readonly #entries: AuditEntry[] = [];
  readonly #file: string | undefined;

  constructor(file?: string) {
    this.#file = file;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.#entries.push(JSON.parse(line) as AuditEntry);
      }
    } else if (file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    }
  }

  append(event: AuditEvent, at: number): AuditEntry {
    const last = this.#entries[this.#entries.length - 1];
    const partial = { ...event, seq: (last?.seq ?? 0) + 1, at, prev: last?.hash ?? GENESIS };
    const entry: AuditEntry = { ...partial, hash: entryHash(partial) };
    this.#entries.push(entry);
    if (this.#file) appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  entries(): readonly AuditEntry[] {
    return this.#entries;
  }

  /** True when every entry still links to the one before it. */
  verify(): boolean {
    let prev = GENESIS;
    let seq = 0;
    for (const entry of this.#entries) {
      const { hash, ...rest } = entry;
      if (entry.prev !== prev || entry.seq !== seq + 1 || entryHash(rest) !== hash) return false;
      prev = hash;
      seq = entry.seq;
    }
    return true;
  }
}
