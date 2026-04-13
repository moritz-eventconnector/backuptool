/**
 * IP allowlist middleware — enforced at the Express layer, independent of Caddy.
 * When the allowlist is non-empty, only matching IPs/CIDRs can reach any route.
 * Localhost (127.0.0.1, ::1) is always permitted to prevent lockout.
 */
import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db/index.js";
import { appConfig } from "../db/schema/index.js";

/** Returns the current UI allowlist from the DB (cached for 10 s). */
let _cache: string[] | null = null;
let _cacheTs = 0;
const CACHE_TTL = 10_000;

export function getUiAllowlist(): string[] {
  if (_cache !== null && Date.now() - _cacheTs < CACHE_TTL) return _cache;
  try {
    const [row] = getDb().select({ uiAllowlist: appConfig.uiAllowlist }).from(appConfig).all();
    _cache = JSON.parse((row?.uiAllowlist as string | null) ?? "[]");
    _cacheTs = Date.now();
    return _cache!;
  } catch {
    return [];
  }
}

/** Invalidate the cache after the setting is saved. */
export function invalidateAllowlistCache(): void {
  _cache = null;
}

/** Express middleware — call once at the top of the router stack. */
export function ipAllowlistMiddleware(req: Request, res: Response, next: NextFunction): void {
  const list = getUiAllowlist();
  if (list.length === 0) { next(); return; }

  const raw = (req.headers["x-real-ip"] as string | undefined)
    ?? (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim()
    ?? req.socket.remoteAddress
    ?? "";

  // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 → 1.2.3.4)
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;

  if (isAllowed(ip, list)) { next(); return; }

  res.status(403).json({ error: "Access denied: your IP is not in the allowlist" });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAllowed(ip: string, list: string[]): boolean {
  // Localhost is always allowed — prevents admin lockout.
  if (ip === "127.0.0.1" || ip === "::1" || ip === "") return true;

  return list.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    return ipMatchesCidr(ip, e);
  });
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes("/")) {
    // Exact match
    return ip === cidr;
  }

  const [network, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr, 10);

  // IPv4 only — IPv6 CIDR is uncommon for allowlists; we accept exact IPv6 only.
  const ipParts = ip.split(".").map(Number);
  const netParts = network.split(".").map(Number);

  if (
    ipParts.length !== 4 || netParts.length !== 4 ||
    ipParts.some(isNaN) || netParts.some(isNaN) ||
    isNaN(prefix) || prefix < 0 || prefix > 32
  ) {
    return false;
  }

  const ipInt = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const netInt = ((netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

  return (ipInt & mask) === (netInt & mask);
}
