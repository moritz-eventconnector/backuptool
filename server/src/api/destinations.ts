import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { destinations } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { encrypt, decrypt } from "../crypto/encryption.js";

export const destinationsRouter = Router();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["s3", "b2", "local", "sftp", "gcs", "azure", "rclone", "wasabi", "minio"]),
  config: z.record(z.unknown()), // provider-specific config (will be encrypted)
});

// GET /api/destinations
destinationsRouter.get("/", requireAuth, (_req, res) => {
  const db = getDb();
  const all = db.select({
    id: destinations.id,
    name: destinations.name,
    type: destinations.type,
    createdAt: destinations.createdAt,
    updatedAt: destinations.updatedAt,
  }).from(destinations).all();
  // Never expose configEncrypted to the UI
  res.json(all);
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

  res.json({ message: "Repository reset. Next backup will initialise a fresh repository at the new path.", newPath: config.path });
});

// DELETE /api/destinations/:id
destinationsRouter.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();
  db.delete(destinations).where(eq(destinations.id, req.params.id)).run();
  res.json({ message: "Destination deleted" });
});
