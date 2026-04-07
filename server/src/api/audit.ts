import { Router } from "express";
import { getDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
import { desc, gte, like, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { requireFeature } from "../licensing/enforcement.js";

export const auditRouter = Router();

// GET /api/audit-logs?limit=200&action=&user=&since=
auditRouter.get("/", requireAuth, requireRole("admin"), requireFeature("audit_log"), (req, res) => {
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

// GET /api/audit-logs/export?format=csv&action=&user=&since=
auditRouter.get("/export", requireAuth, requireRole("admin"), requireFeature("audit_log"), (req, res) => {
  const db = getDb();
  const format = (req.query.format as string) || "csv";
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
    .limit(10000)
    .all();

  if (format === "csv") {
    const headers = ["id", "userEmail", "action", "resource", "ip", "userAgent", "createdAt"];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      headers.join(","),
      ...rows.map(r => [r.id, r.userEmail, r.action, r.resource, r.ip, r.userAgent, r.createdAt].map(escape).join(",")),
    ].join("\n");

    const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } else {
    res.json(rows);
  }
});
