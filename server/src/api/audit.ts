import { Router } from "express";
import { getDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
import { desc, gte, like, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";

export const auditRouter = Router();

// GET /api/audit-logs?limit=200&action=&user=&since=
auditRouter.get("/", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt((req.query.limit as string) ?? "200", 10), 1000);
  const actionFilter = (req.query.action as string) || null;
  const userFilter = (req.query.user as string) || null;
  const since = (req.query.since as string) || null;

  const conditions = [];
  if (actionFilter) conditions.push(like(auditLog.action, `%${actionFilter}%`));
  if (userFilter) conditions.push(like(auditLog.userEmail, `%${userFilter}%`));
  if (since) conditions.push(gte(auditLog.createdAt, since));

  const rows = db.select().from(auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .all();

  res.json(rows);
});
