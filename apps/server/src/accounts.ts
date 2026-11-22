import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Amounts are whole micro-dollars throughout, the same unit as USDC. */
export interface AccountEntry {
  kind: "topup" | "task";
  /** Positive for a top-up, negative for a charge. */
  amount: number;
  at: number;
  /** For a top-up, the card payment reference. For a task, its id. */
  reference: string;
  capability?: string;
  transaction?: string;
}

interface Account {
  id: string;
  keyHash: string;
  credit: number;
  reserved: number;
  entries: AccountEntry[];
  references: Set<string>;
}

type Event =
  | { t: "account"; id: string; keyHash: string; at: number }
  | { t: "credit"; id: string; amount: number; reference: string; at: number }
  | { t: "debit"; id: string; amount: number; reference: string; capability: string; transaction: string; at: number };

const hashKey = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex");

/**
 * Prepaid credit for renters who pay by card. The marketplace holds this
 * balance on the renter's behalf, so every change is written to an
 * append-only file before it is acknowledged. API keys are stored only as
 * hashes.
 */
export class AccountStore {
  readonly #accounts = new Map<string, Account>();
  readonly #byKey = new Map<string, string>();
  readonly #reservations = new Map<string, { accountId: string; amount: number }>();
  readonly #file: string | undefined;

  constructor(file?: string) {
    this.#file = file;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.#apply(JSON.parse(line) as Event);
      }
    } else if (file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    }
  }

  #apply(event: Event): void {
    if (event.t === "account") {
      this.#accounts.set(event.id, { id: event.id, keyHash: event.keyHash, credit: 0, reserved: 0, entries: [], references: new Set() });
      this.#byKey.set(event.keyHash, event.id);
      return;
    }
    const account = this.#accounts.get(event.id);
    if (!account) return;
    if (event.t === "credit") {
      account.credit += event.amount;
      account.references.add(event.reference);
      account.entries.push({ kind: "topup", amount: event.amount, at: event.at, reference: event.reference });
    } else {
      account.credit -= event.amount;
      account.entries.push({
        kind: "task",
        amount: -event.amount,
        at: event.at,
        reference: event.reference,
        capability: event.capability,
        transaction: event.transaction,
      });
    }
  }

  #write(event: Event): void {
    if (this.#file) appendFileSync(this.#file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.#apply(event);
  }

  /** Creates an account. The API key is returned once and cannot be recovered afterwards. */
  create(now = Date.now()): { accountId: string; apiKey: string } {
    const accountId = `acct_${randomBytes(9).toString("base64url")}`;
    const apiKey = `abnb_${randomBytes(32).toString("base64url")}`;
    this.#write({ t: "account", id: accountId, keyHash: hashKey(apiKey), at: now });
    return { accountId, apiKey };
  }

  /** Returns the account id for a valid API key, or null. */
  authenticate(apiKey: string): string | null {
    if (!/^abnb_[A-Za-z0-9_-]{43}$/.test(apiKey)) return null;
    return this.#byKey.get(hashKey(apiKey)) ?? null;
  }

  /** Credit that can be spent right now: the balance less anything held for tasks in flight. */
  available(accountId: string): number {
    const account = this.#accounts.get(accountId);
    return account ? account.credit - account.reserved : 0;
  }

  /** Adds credit for a card payment. The same payment reference is never credited twice. */
  credit(accountId: string, amount: number, reference: string, now = Date.now()): boolean {
    const account = this.#accounts.get(accountId);
    if (!account) throw new RangeError("unknown account");
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError("credit must be a positive whole amount");
    if (account.references.has(reference)) return false;
    this.#write({ t: "credit", id: accountId, amount, reference, at: now });
    return true;
  }

  /** Holds credit for a task that is about to run. Returns null if there is not enough. */
  reserve(accountId: string, amount: number): string | null {
    const account = this.#accounts.get(accountId);
    if (!account || !Number.isSafeInteger(amount) || amount <= 0) return null;
    if (account.credit - account.reserved < amount) return null;
    account.reserved += amount;
    const id = randomBytes(12).toString("base64url");
    this.#reservations.set(id, { accountId, amount });
    return id;
  }

  /** The task completed and the host was paid: turn the hold into a charge. */
  commit(reservation: string, memo: { taskId: string; capability: string; transaction: string }, now = Date.now()): void {
    const held = this.#reservations.get(reservation);
    if (!held) throw new RangeError("unknown reservation");
    this.#reservations.delete(reservation);
    const account = this.#accounts.get(held.accountId)!;
    account.reserved -= held.amount;
    this.#write({ t: "debit", id: held.accountId, amount: held.amount, reference: memo.taskId, capability: memo.capability, transaction: memo.transaction, at: now });
  }

  /** The task did not complete: give the held credit back. */
  release(reservation: string): void {
    const held = this.#reservations.get(reservation);
    if (!held) return;
    this.#reservations.delete(reservation);
    this.#accounts.get(held.accountId)!.reserved -= held.amount;
  }

  /** Newest first. */
  history(accountId: string, limit = 50): AccountEntry[] {
    const account = this.#accounts.get(accountId);
    return account ? account.entries.slice(-limit).reverse() : [];
  }

  /** Total credit currently owed to renters across all accounts. */
  outstanding(): number {
    let total = 0;
    for (const account of this.#accounts.values()) total += account.credit;
    return total;
  }
}
