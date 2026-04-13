import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { appConfig } from "../db/schema/index.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { logger } from "../logger.js";
import { invalidateAllowlistCache } from "../middleware/ipAllowlist.js";

export const appConfigRouter = Router();

// GET /api/settings/app-config
appConfigRouter.get("/app-config", requireAuth, (_req, res) => {
  const db = getDb();
  const [row] = db.select().from(appConfig).all();
  const base = row ?? { serverName: "BackupTool", serverUrl: null, setupCompleted: false, releasesBaseUrl: null, resticBin: "restic", rcloneBin: "rclone", uiAllowlist: "[]" };
  res.json({
    ...base,
    uiAllowlist: JSON.parse((base.uiAllowlist as string | null) ?? "[]") as string[],
  });
});

// GET /api/settings/setup-status — no auth needed (used before login to redirect)
appConfigRouter.get("/setup-status", (_req, res) => {
  const db = getDb();
  const [row] = db.select({ setupCompleted: appConfig.setupCompleted }).from(appConfig).all();
  res.json({ setupCompleted: row?.setupCompleted ?? false });
});

const appConfigSchema = z.object({
  serverName: z.string().min(1).max(100).optional(),
  serverUrl: z.string().url().or(z.literal("")).optional(),
  setupCompleted: z.boolean().optional(),
  releasesBaseUrl: z.string().url().or(z.literal("")).optional(),
  resticBin: z.string().min(1).optional(),
  rcloneBin: z.string().min(1).optional(),
  uiAllowlist: z.array(z.string()).optional(),
});

// PUT /api/settings/app-config
appConfigRouter.put("/app-config", requireAuth, requireRole("admin"), (req, res) => {
  const parse = appConfigSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const values: Record<string, unknown> = {
    ...parse.data,
    serverUrl: parse.data.serverUrl || null,
    releasesBaseUrl: parse.data.releasesBaseUrl || null,
    uiAllowlist: parse.data.uiAllowlist !== undefined ? JSON.stringify(parse.data.uiAllowlist) : undefined,
    updatedAt: new Date().toISOString(),
  };
  // Remove undefined keys so onConflictDoUpdate only touches provided fields
  Object.keys(values).forEach((k) => values[k] === undefined && delete values[k]);

  db.insert(appConfig)
    .values({ id: "singleton", ...values } as typeof appConfig.$inferInsert)
    .onConflictDoUpdate({ target: appConfig.id, set: values as Partial<typeof appConfig.$inferInsert> })
    .run();

  invalidateAllowlistCache();
  logger.info("App config updated");
  res.json({ message: "Saved" });
});
