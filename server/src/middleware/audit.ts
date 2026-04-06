import type { Request } from "express";
import { getDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
import { nanoid } from "nanoid";

type AuditUser = { id: string; email: string } | undefined;

/**
 * Write a single audit log entry.  Call this at the end of any mutating handler
 * that has already verified authentication (req.user is populated by requireAuth).
 */
export function writeAuditLog(
  req: Request,
  action: string,
  resource?: string,
  details?: Record<string, unknown>,
): void {
  try {
    const user = (req as Request & { user?: AuditUser }).user;
    const db = getDb();
    db.insert(auditLog).values({
      id: nanoid(),
      userId: user?.id ?? null,
      userEmail: user?.email ?? null,
      action,
      resource: resource ?? null,
      details: details ? JSON.stringify(details) : null,
      ip: req.ip ?? (req.socket?.remoteAddress ?? null),
      userAgent: (req.headers["user-agent"] as string) ?? null,
    }).run();
  } catch { /* audit failures are non-fatal */ }
}
