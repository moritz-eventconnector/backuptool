import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { destinations, snapshots, backupJobs } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { encrypt, decrypt } from "../crypto/encryption.js";
import { writeAuditLog } from "../middleware/audit.js";

export const destinationsRouter = Router();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["s3", "b2", "local", "sftp", "gcs", "azure", "rclone", "wasabi", "minio"]),
  config: z.record(z.unknown()), // provider-specific config (will be encrypted)
});

// GET /api/destinations
destinationsRouter.get("/", requireAuth, (_req, res) => {
  const db = getDb();
  const all = db.select().from(destinations).all();
  // Return safe fields + a non-sensitive repoSummary derived from config
  const result = all.map((d) => {
    let repoSummary = "";
    try {
      const cfg = JSON.parse(decrypt(d.configEncrypted)) as Record<string, unknown>;
      const path = ((cfg.path as string) ?? "").replace(/\/$/, "");
      switch (d.type) {
        case "s3": case "b2": case "wasabi": case "minio": {
          const bucket = (cfg.bucket as string) ?? "";
          repoSummary = path ? `${bucket}/${path}` : bucket;
          break;
        }
        case "local":
          repoSummary = (cfg.path as string) ?? "";
          break;
        case "sftp":
          repoSummary = `${cfg.host ?? ""}:${cfg.path ?? ""}`;
          break;
        case "rclone":
          repoSummary = (cfg.remote as string) ?? "";
          break;
        case "gcs":
          repoSummary = path ? `${cfg.bucket}/${path}` : (cfg.bucket as string) ?? "";
          break;
      }
    } catch { /**/ }
    return { id: d.id, name: d.name, type: d.type, repoSummary, createdAt: d.createdAt, updatedAt: d.updatedAt };
  });
  res.json(result);
});

// GET /api/destinations/:id — returns decrypted config (admin only)
destinationsRouter.get("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();
  const [dest] = db.select().from(destinations).where(eq(destinations.id, req.params.id)).all();
  if (!dest) {
    res.status(404).json({ error: "Destination not found" });
    return;
  }
  const config = JSON.parse(decrypt(dest.configEncrypted));
  res.json({ id: dest.id, name: dest.name, type: dest.type, config, createdAt: dest.createdAt });
});

// POST /api/destinations
destinationsRouter.post("/", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const parse = createSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const configEncrypted = encrypt(JSON.stringify(parse.data.config));
  const id = nanoid();
  const db = getDb();

  db.insert(destinations).values({
    id,
    name: parse.data.name,
    type: parse.data.type,
    configEncrypted,
  }).run();

  writeAuditLog(req, "create_destination", `destination:${id}`, { name: parse.data.name, type: parse.data.type });
  res.status(201).json({ id, name: parse.data.name, type: parse.data.type });
});

// PUT /api/destinations/:id
destinationsRouter.put("/:id", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const parse = createSchema.partial().safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const [dest] = db.select().from(destinations).where(eq(destinations.id, req.params.id)).all();
  if (!dest) {
    res.status(404).json({ error: "Destination not found" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parse.data.name) updates.name = parse.data.name;
  if (parse.data.type) updates.type = parse.data.type;
  if (parse.data.config) updates.configEncrypted = encrypt(JSON.stringify(parse.data.config));

  db.update(destinations)
    .set(updates as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(destinations.id, req.params.id))
    .run();

  writeAuditLog(req, "update_destination", `destination:${req.params.id}`);
  res.json({ message: "Destination updated" });
});

// POST /api/destinations/:id/reset-repo — appends a new path version so the next
// backup initialises a fresh restic repository (fixes password-mismatch errors).
destinationsRouter.post("/:id/reset-repo", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();
  const [dest] = db.select().from(destinations).where(eq(destinations.id, req.params.id)).all();
  if (!dest) {
    res.status(404).json({ error: "Destination not found" });
    return;
  }

  const config = JSON.parse(decrypt(dest.configEncrypted)) as Record<string, unknown>;
  // Strip any previous reset suffix, then append a new timestamp-based version.
  const base = ((config.path as string) ?? "").replace(/\/$/, "").replace(/-r\d+$/, "");
  const ts = Math.floor(Date.now() / 1000);
  config.path = (base ? base + "-" : "") + `r${ts}`;

  db.update(destinations)
    .set({ configEncrypted: encrypt(JSON.stringify(config)), updatedAt: new Date().toISOString() } as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(destinations.id, req.params.id))
    .run();

  // Mark all snapshots for every job that uses this destination as orphaned.
  // We can't filter by snapshots.destinationId directly because that field is often null;
  // instead we find affected jobs through their destinationIds JSON array.
  const allJobs = db.select({ id: backupJobs.id, destinationIds: backupJobs.destinationIds }).from(backupJobs).all();
  const affectedJobIds = allJobs
    .filter((j) => {
      const dids: string[] = JSON.parse(j.destinationIds ?? "[]");
      return dids.includes(req.params.id);
    })
    .map((j) => j.id);

  for (const jobId of affectedJobIds) {
    db.update(snapshots)
      .set({ status: "orphaned" } as Parameters<ReturnType<typeof db.update>["set"]>[0])
      .where(eq(snapshots.jobId, jobId))
      .run();
  }

  writeAuditLog(req, "reset_destination_repo", `destination:${req.params.id}`, { newPath: config.path });
  res.json({ message: "Repository reset. Next backup will initialise a fresh repository at the new path.", newPath: config.path });
});

// DELETE /api/destinations/:id
destinationsRouter.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();
  db.delete(destinations).where(eq(destinations.id, req.params.id)).run();
  writeAuditLog(req, "delete_destination", `destination:${req.params.id}`);
  res.json({ message: "Destination deleted" });
});
