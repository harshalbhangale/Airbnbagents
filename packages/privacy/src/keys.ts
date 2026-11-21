import { generateKeyPairSync, createPrivateKey, sign as nodeSign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateEncryptionKeyPair, keyId, toB64, type EncryptionKeyPair } from "@agentbnb/protocol";

/** The worker's identity: one key pair for decrypting tasks, one for signing receipts. */
export class WorkerKeys {
  readonly #encryption: EncryptionKeyPair;
  readonly #signing: KeyObject;
  readonly signingPublicKey: string;

  private constructor(encryption: EncryptionKeyPair, signingPrivateJwk: { d: string; x: string }) {
    this.#encryption = encryption;
    this.#signing = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: signingPrivateJwk.d, x: signingPrivateJwk.x },
      format: "jwk",
    });
    this.signingPublicKey = signingPrivateJwk.x;
  }

  static async generate(): Promise<WorkerKeys> {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
    return new WorkerKeys(await generateEncryptionKeyPair(), { d: jwk.d, x: jwk.x });
  }

  /** Loads the keys from `dir`, creating them on first run. The file is readable by the owner only. */
  static async loadOrCreate(dir: string): Promise<WorkerKeys> {
    const file = join(dir, "worker-keys.json");
    if (existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, "utf8")) as {
        encryption: EncryptionKeyPair;
        signing: { d: string; x: string };
      };
      return new WorkerKeys(stored.encryption, stored.signing);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
    const stored = { encryption: await generateEncryptionKeyPair(), signing: { d: jwk.d, x: jwk.x } };
    writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    chmodSync(file, 0o600);
    return new WorkerKeys(stored.encryption, stored.signing);
  }

  get encryptionPublicKey(): string {
    return this.#encryption.publicKey;
  }

  get keyId(): string {
    return keyId(this.#encryption.publicKey);
  }

  /** Used only by the privacy layer. */
  get encryptionPrivateKey(): string {
    return this.#encryption.privateKey;
  }

  sign(message: Uint8Array): string {
    return toB64(nodeSign(null, message, this.#signing));
  }
}
