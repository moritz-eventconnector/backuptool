/**
 * License enforcement helpers.
 *
 * Call `getCurrentLicense()` to get the active license info, then use
 * `requireFeature()` or `requireSeat()` middleware in API route handlers.
 */
import { type Request, type Response, type NextFunction } from "express";
import { getDb } from "../db/index.js";
import { license as licenseTable, agents } from "../db/schema/index.js";
import { communityLicense, hasFeature, type LicenseInfo } from "./verifier.js";

/** Returns the current active license (falls back to community). */
export function getCurrentLicense(): LicenseInfo {
  const db = getDb();
  const [row] = db.select().from(licenseTable).all();
  if (!row) return communityLicense();

  const exp = row.expiresAt ? Math.floor(new Date(row.expiresAt).getTime() / 1000) : undefined;
  const expired = exp !== undefined && exp < Math.floor(Date.now() / 1000);

  return {
    sub: row.customerId ?? "unknown",
    name: row.customerName ?? undefined,
    edition: row.edition as LicenseInfo["edition"],
    seats: row.seats,
    features: JSON.parse(row.features) as string[],
    exp,
    iat: Math.floor(new Date(row.activatedAt).getTime() / 1000),
    valid: !expired,
    expired,
    raw: "",
  };
}

/**
 * Express middleware — rejects with 402 if the license has expired.
 * Restores are intentionally NOT gated — always allow data recovery.
 */
export function requireActiveLicense() {
  return (_req: Request, res: Response, next: NextFunction) => {
    const lic = getCurrentLicense();
    if (lic.expired) {
      res.status(402).json({
        error: "Your license has expired. New backups are blocked until the license is renewed. Restores remain available.",
        expiredAt: lic.exp ? new Date(lic.exp * 1000).toISOString() : null,
        currentEdition: lic.edition,
        upgrade: "Upload a renewed license to resume backups.",
      });
      return;
    }
    next();
  };
}

/**
 * Express middleware — rejects with 402 if the license does not include `feature`.
 * Enterprise edition always passes (all features included).
 */
export function requireFeature(feature: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const lic = getCurrentLicense();
    if (!hasFeature(lic, feature)) {
      res.status(402).json({
        error: `Your current license (${lic.edition}) does not include this feature.`,
        feature,
        currentEdition: lic.edition,
        upgrade: "Upload a higher-tier license to unlock this feature.",
      });
      return;
    }
    next();
  };
}

/**
 * Express middleware — rejects agent registration if the seat limit is reached.
 * seats = 0 means unlimited.
 */
export function requireSeat() {
  return (_req: Request, res: Response, next: NextFunction) => {
    const lic = getCurrentLicense();
    if (lic.seats === 0) { next(); return; } // unlimited

    const db = getDb();
    const count = db.select().from(agents).all().length;

    if (count >= lic.seats) {
      res.status(402).json({
        error: `Agent seat limit reached. Your ${lic.edition} license allows ${lic.seats} agent${lic.seats === 1 ? "" : "s"} (${count} registered).`,
        seats: lic.seats,
        currentAgents: count,
        currentEdition: lic.edition,
        upgrade: "Upload a license with more seats to register additional agents.",
      });
      return;
    }
    next();
  };
}
