/**
 * RS256 JWT auth — asymmetric keypair.
 * Private key signs access tokens; public key verifies them.
 * Agents can verify tokens using only the public key.
 */
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import { config } from "../config.js";
import { logger } from "../logger.js";

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let privateKey: string;
let publicKey: string;

export function initJwtKeys(): void {
  fs.mkdirSync(config.keysDir, { recursive: true });

  if (fs.existsSync(config.jwtPrivateKeyPath) && fs.existsSync(config.jwtPublicKeyPath)) {
    privateKey = fs.readFileSync(config.jwtPrivateKeyPath, "utf8");
    publicKey = fs.readFileSync(config.jwtPublicKeyPath, "utf8");
    logger.info("JWT RS256 keypair loaded from disk");
    return;
  }

  logger.info("Generating JWT RS256 keypair...");
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 4096,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  fs.writeFileSync(config.jwtPrivateKeyPath, priv, { mode: 0o600 });
  fs.writeFileSync(config.jwtPublicKeyPath, pub);

  privateKey = priv;
  publicKey = pub;
  logger.info("JWT RS256 keypair generated");
}

export function getPublicKey(): string {
  return publicKey;
}

export interface JwtPayload {
  sub: string;   // user ID
  email: string;
  role: string;
  type: "access";
}

export function signAccessToken(payload: Omit<JwtPayload, "type">): string {
  return jwt.sign({ ...payload, type: "access" }, privateKey, {
    algorithm: "RS256",
    expiresIn: ACCESS_TOKEN_TTL,
    issuer: "backuptool",
  });
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: "backuptool",
  }) as JwtPayload;
}

export function refreshTokenTtlMs(): number {
  return REFRESH_TOKEN_TTL_MS;
}

// ── TOTP pending token (short-lived, HS256 with a symmetric secret) ───────────
// Used when a user passes password but hasn't yet submitted their TOTP code.
// We don't want to issue a full access token at this point.

const TOTP_PENDING_TTL = "5m";
// Derive a symmetric secret from the RS256 private key so we don't need extra config.
function totpHmacSecret(): string {
  return privateKey.slice(0, 64); // first 64 bytes of PEM text — deterministic
}

export interface TotpPendingPayload {
  sub: string;   // user ID
  type: "totp_pending";
}

export function signTotpPendingToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "totp_pending" }, totpHmacSecret(), {
    algorithm: "HS256",
    expiresIn: TOTP_PENDING_TTL,
  });
}

export function verifyTotpPendingToken(token: string): TotpPendingPayload {
  return jwt.verify(token, totpHmacSecret(), { algorithms: ["HS256"] }) as TotpPendingPayload;
}
