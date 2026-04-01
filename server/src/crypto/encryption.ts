/**
 * AES-256-GCM encryption for sensitive data at rest (credentials, SSO configs).
 * Uses PBKDF2 to derive a key from the master secret + a per-record salt.
 */
import crypto from "crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha256";

function deriveKey(salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    Buffer.from(config.masterSecret, "utf8"),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LEN,
    PBKDF2_DIGEST
  );
}

/**
 * Encrypts a plaintext string and returns a base64-encoded ciphertext blob.
 * Format: base64( salt[16] + iv[12] + tag[16] + ciphertext )
 */
export function encrypt(plaintext: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const blob = Buffer.concat([salt, iv, tag, enc]);
  return blob.toString("base64");
}

/**
 * Decrypts a base64-encoded ciphertext blob produced by `encrypt()`.
 */
export function decrypt(ciphertextBase64: string): string {
  const blob = Buffer.from(ciphertextBase64, "base64");
  if (blob.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error("Invalid ciphertext: too short");
  }

  const salt = blob.subarray(0, SALT_LEN);
  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = blob.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

/**
 * Hashes a value with SHA-256, returns hex string.
 */
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Generates a cryptographically secure random token (URL-safe base64).
 */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
