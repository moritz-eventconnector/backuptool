/**
 * Machine fingerprint — a stable, unique identifier for this server instance.
 *
 * Sources (in order of preference):
 *  1. /etc/machine-id   — present on all systemd Linux systems, stable across reboots
 *  2. hostname           — fallback for macOS / dev environments
 *
 * The raw value is SHA-256 hashed so the actual machine-id is never exposed in
 * the license or in log output.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { hostname } from "os";

let _cached: string | null = null;

export function getMachineFingerprint(): string {
  if (_cached) return _cached;

  let raw: string;
  try {
    raw = readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    // macOS or container without machine-id — fall back to hostname
    raw = hostname();
  }

  _cached = "sha256:" + createHash("sha256").update(raw).digest("hex");
  return _cached;
}
