import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { appConfig } from "../db/schema/index.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { logger } from "../logger.js";

export const appConfigRouter = Router();

// GET /api/settings/app-config
appConfigRouter.get("/app-config", requireAuth, (_req, res) => {
  const db = getDb();
  const [row] = db.select().from(appConfig).all();
  res.json(row ?? {
    serverName: "BackupTool",
    serverUrl: null,
    setupCompleted: false,
    releasesBaseUrl: null,
    resticBin: "restic",
    rcloneBin: "rclone",
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
    updatedAt: new Date().toISOString(),
  };

  db.insert(appConfig)
    .values({ id: "singleton", ...values } as typeof appConfig.$inferInsert)
    .onConflictDoUpdate({ target: appConfig.id, set: values as Partial<typeof appConfig.$inferInsert> })
    .run();

  logger.info("App config updated");
  res.json({ message: "Saved" });
});
