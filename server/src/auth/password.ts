/**
 * Argon2id password hashing — OWASP recommended.
 * Uses @node-rs/argon2 for native performance.
 */
import { hash, verify, Algorithm } from "@node-rs/argon2";

// OWASP recommended Argon2id parameters (2023)
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536,    // 64 MiB
  timeCost: 3,          // iterations
  parallelism: 4,
  outputLen: 32,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  return verify(hashed, password, ARGON2_OPTIONS);
}
