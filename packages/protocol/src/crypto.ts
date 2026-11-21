import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { fromB64, sha256Hex, toB64, utf8 } from "./bytes.ts";

/**
 * Public-key encryption for task payloads: HPKE (RFC 9180) with
 * X25519 + HKDF-SHA256 + ChaCha20-Poly1305. One fresh ephemeral key per
 * message, and the routing metadata is bound in as associated data, so a
 * relay cannot re-label a ciphertext without breaking decryption.
 */
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

export interface EncryptionKeyPair {
  /** base64url, 32 bytes */
  publicKey: string;
  /** base64url, 32 bytes. Never leaves the machine that generated it. */
  privateKey: string;
}

export interface Sealed {
  /** HPKE encapsulated key, base64url */
  enc: string;
  /** ciphertext, base64url */
  ciphertext: string;
}

export async function generateEncryptionKeyPair(): Promise<EncryptionKeyPair> {
  const pair = await suite.kem.generateKeyPair();
  return {
    publicKey: toB64(await suite.kem.serializePublicKey(pair.publicKey)),
    privateKey: toB64(await suite.kem.serializePrivateKey(pair.privateKey)),
  };
}

export function keyId(publicKeyB64: string): string {
  return sha256Hex(fromB64(publicKeyB64)).slice(0, 16);
}

export async function seal(
  recipientPublicKey: string,
  plaintext: Uint8Array,
  context: { info: string; aad: string },
): Promise<Sealed> {
  const key = await suite.kem.deserializePublicKey(fromB64(recipientPublicKey));
  const { ct, enc } = await suite.seal(
    { recipientPublicKey: key, info: utf8(context.info) },
    plaintext,
    utf8(context.aad),
  );
  return { enc: toB64(enc), ciphertext: toB64(ct) };
}

/** Throws if the key is wrong or the ciphertext, info or associated data were altered. */
export async function open(
  recipientPrivateKey: string,
  sealed: Sealed,
  context: { info: string; aad: string },
): Promise<Uint8Array> {
  const key = await suite.kem.deserializePrivateKey(fromB64(recipientPrivateKey));
  const plaintext = await suite.open(
    { recipientKey: key, enc: fromB64(sealed.enc), info: utf8(context.info) },
    fromB64(sealed.ciphertext),
    utf8(context.aad),
  );
  return new Uint8Array(plaintext);
}

export function sealedHash(sealed: Sealed): string {
  return sha256Hex(fromB64(sealed.enc), fromB64(sealed.ciphertext));
}

/** Verifies an Ed25519 signature. `publicKey` is the raw 32-byte key, base64url. */
export function verifySignature(publicKey: string, message: Uint8Array, signature: string): boolean {
  try {
    const raw = fromB64(publicKey);
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: toB64(raw) }, format: "jwk" });
    return nodeVerify(null, message, key, fromB64(signature));
  } catch {
    return false;
  }
}
