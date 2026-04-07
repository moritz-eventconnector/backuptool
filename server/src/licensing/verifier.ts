/**
 * Offline license verification using Ed25519 signatures.
 *
 * The vendor holds the Ed25519 private key and signs license files.
 * The public key is compiled into this binary — replacing it requires
 * rebuilding the server, which prevents key-swapping attacks.
 *
 * To generate a new keypair:  licenser keygen
 * Then replace VENDOR_PUBLIC_KEY below with the base64url-encoded public key.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { logger } from "../logger.js";
import { getMachineFingerprint } from "./fingerprint.js";

// Required for @noble/ed25519 in Node.js
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ---------------------------------------------------------------------------
// VENDOR PUBLIC KEY — hardcoded at build time, do NOT move to env/config.
// Replace this value after running: licenser keygen
// Format: base64url-encoded raw Ed25519 public key bytes (32 bytes → 43 chars)
// ---------------------------------------------------------------------------
const VENDOR_PUBLIC_KEY = "REPLACE_WITH_YOUR_ED25519_PUBLIC_KEY_BASE64URL";

export interface LicensePayload {
  sub: string;          // customer ID
  name?: string;        // customer name
  edition: "community" | "pro" | "enterprise";
  seats: number;        // max agents (0 = unlimited)
  features: string[];   // feature flags
  exp?: number;         // unix timestamp, undefined = perpetual
  iat: number;          // issued at unix timestamp
  fingerprint?: string; // optional machine fingerprint
}

export interface LicenseInfo extends LicensePayload {
  valid: boolean;
  expired: boolean;
  raw: string;
}

function b64urlDecode(s: string): Uint8Array {
  // Base64url → standard base64 → Buffer
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export async function verifyLicense(rawJwt: string): Promise<LicenseInfo> {
  const parts = rawJwt.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid license format: expected 3 JWT parts");
  }

  const [headerB64, payloadB64, sigB64] = parts;

  // Decode payload
  const payloadJson = Buffer.from(b64urlDecode(payloadB64)).toString("utf8");
  const payload = JSON.parse(payloadJson) as LicensePayload;

  // Verify Ed25519 signature against the hardcoded vendor public key
  if (VENDOR_PUBLIC_KEY.startsWith("REPLACE_")) {
    logger.warn("Vendor public key not configured — license verification skipped (dev mode)");
    return { ...payload, valid: true, expired: false, raw: rawJwt };
  }

  const publicKey = b64urlDecode(VENDOR_PUBLIC_KEY);
  const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlDecode(sigB64);

  const isValid = await ed.verify(signature, message, publicKey);
  if (!isValid) {
    throw new Error("License signature verification failed — invalid or tampered license");
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  const expired = payload.exp !== undefined && payload.exp < now;

  // Check fingerprint if the license contains one
  if (payload.fingerprint) {
    const machineFingerprint = getMachineFingerprint();
    if (payload.fingerprint !== machineFingerprint) {
      throw new Error(
        `License is locked to a different server (fingerprint mismatch).\n` +
        `Expected: ${payload.fingerprint}\n` +
        `This server: ${machineFingerprint}`
      );
    }
  }

  return {
    ...payload,
    valid: isValid && !expired,
    expired,
    raw: rawJwt,
  };
}

/**
 * Checks if a feature is enabled given the current license.
 */
export function hasFeature(license: LicensePayload, feature: string): boolean {
  return license.features.includes(feature) || license.edition === "enterprise";
}

/**
 * Returns the default community license (used when no license file is uploaded).
 */
export function communityLicense(): LicenseInfo {
  return {
    sub: "community",
    edition: "community",
    seats: 1,
    features: [],
    iat: 0,
    valid: true,
    expired: false,
    raw: "",
  };
}
