import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { backupJobs, agents, snapshots } from "../db/schema/index.js";
import { eq, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { sendToAgent } from "../websocket/index.js";
import { encrypt, randomToken } from "../crypto/encryption.js";

export const jobsRouter = Router();

const retentionSchema = z.object({
  keepLast: z.number().int().min(0).optional(),
  keepDaily: z.number().int().min(0).optional(),
  keepWeekly: z.number().int().min(0).optional(),
  keepMonthly: z.number().int().min(0).optional(),
  keepYearly: z.number().int().min(0).optional(),
}).default({});

const createJobSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(200),
  sourcePaths: z.array(z.string().min(1)).min(1),
  destinationIds: z.array(z.string()).min(1),
  schedule: z.string().optional(), // cron expression
  retention: retentionSchema,
  preScript: z.string().optional(),
  postScript: z.string().optional(),
  excludePatterns: z.array(z.string()).default([]),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryDelaySeconds: z.number().int().min(0).default(60),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

// GET /api/jobs
jobsRouter.get("/", requireAuth, (_req, res) => {
  const db = getDb();
  const all = db.select().from(backupJobs).all();
  res.json(all.map(deserializeJob));
});

// GET /api/jobs/:id
jobsRouter.get("/:id", requireAuth, (req, res) => {
  const db = getDb();
  const [job] = db.select().from(backupJobs).where(eq(backupJobs.id, req.params.id)).all();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(deserializeJob(job));
});

// POST /api/jobs
jobsRouter.post("/", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const parse = createJobSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const [agent] = db.select().from(agents).where(eq(agents.id, parse.data.agentId)).all();
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Generate a secure Restic repository password for this job (stored encrypted)
  const resticPassword = randomToken(24);
  const resticPasswordEncrypted = encrypt(resticPassword);

  const id = nanoid();
  db.insert(backupJobs).values({
    id,
    agentId: parse.data.agentId,
    name: parse.data.name,
    sourcePaths: JSON.stringify(parse.data.sourcePaths),
    destinationIds: JSON.stringify(parse.data.destinationIds),
    schedule: parse.data.schedule,
    retention: JSON.stringify(parse.data.retention),
    resticPasswordEncrypted,
    preScript: parse.data.preScript,
    postScript: parse.data.postScript,
    excludePatterns: JSON.stringify(parse.data.excludePatterns),
    maxRetries: parse.data.maxRetries,
    retryDelaySeconds: parse.data.retryDelaySeconds,
    tags: JSON.stringify(parse.data.tags),
    enabled: parse.data.enabled,
  }).run();

  // Push updated job list to agent via WebSocket
  sendToAgent(parse.data.agentId, { type: "sync_jobs" });

  const [created] = db.select().from(backupJobs).where(eq(backupJobs.id, id)).all();
  res.status(201).json(deserializeJob(created));
});

// PUT /api/jobs/:id
jobsRouter.put("/:id", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const parse = createJobSchema.partial().safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const [job] = db.select().from(backupJobs).where(eq(backupJobs.id, req.params.id)).all();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parse.data.name) updates.name = parse.data.name;
  if (parse.data.sourcePaths) updates.sourcePaths = JSON.stringify(parse.data.sourcePaths);
  if (parse.data.destinationIds) updates.destinationIds = JSON.stringify(parse.data.destinationIds);
  if ("schedule" in parse.data) updates.schedule = parse.data.schedule;
  if (parse.data.retention) updates.retention = JSON.stringify(parse.data.retention);
  if ("preScript" in parse.data) updates.preScript = parse.data.preScript;
  if ("postScript" in parse.data) updates.postScript = parse.data.postScript;
  if (parse.data.excludePatterns) updates.excludePatterns = JSON.stringify(parse.data.excludePatterns);
  if ("maxRetries" in parse.data) updates.maxRetries = parse.data.maxRetries;
  if ("retryDelaySeconds" in parse.data) updates.retryDelaySeconds = parse.data.retryDelaySeconds;
  if ("enabled" in parse.data) updates.enabled = parse.data.enabled;

  db.update(backupJobs)
    .set(updates as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(backupJobs.id, req.params.id))
    .run();

  sendToAgent(job.agentId, { type: "sync_jobs" });
  const [updated] = db.select().from(backupJobs).where(eq(backupJobs.id, req.params.id)).all();
  res.json(deserializeJob(updated));
});

// DELETE /api/jobs/:id
jobsRouter.delete("/:id", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const db = getDb();
  const [job] = db.select().from(backupJobs).where(eq(backupJobs.id, req.params.id)).all();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  db.delete(backupJobs).where(eq(backupJobs.id, req.params.id)).run();
  sendToAgent(job.agentId, { type: "sync_jobs" });
  res.json({ message: "Job deleted" });
});

// POST /api/jobs/:id/run — trigger manual backup
jobsRouter.post("/:id/run", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const db = getDb();
  const [job] = db.select().from(backupJobs).where(eq(backupJobs.id, req.params.id)).all();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const snapshotId = nanoid();
  db.insert(snapshots).values({
    id: snapshotId,
    jobId: job.id,
    agentId: job.agentId,
    status: "running",
  }).run();

  const sent = sendToAgent(job.agentId, {
    type: "run_job",
    jobId: job.id,
    snapshotId,
    job: deserializeJob(job),
  });

  if (!sent) {
    db.update(snapshots)
      .set({ status: "failed", errorMessage: "Agent is offline", finishedAt: new Date().toISOString() })
      .where(eq(snapshots.id, snapshotId))
      .run();
    res.status(503).json({ error: "Agent is offline" });
    return;
  }

  // Mark agent as busy
  db.update(agents).set({ status: "busy" }).where(eq(agents.id, job.agentId)).run();

  res.json({ snapshotId, message: "Backup triggered" });
});

// GET /api/jobs/:id/snapshots
jobsRouter.get("/:id/snapshots", requireAuth, (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit as string ?? "50", 10), 200);
  const all = db.select().from(snapshots)
    .where(eq(snapshots.jobId, req.params.id))
    .orderBy(desc(snapshots.startedAt))
    .limit(limit)
    .all();
  res.json(all);
});

function deserializeJob(job: typeof backupJobs.$inferSelect) {
  return {
    ...job,
    sourcePaths: JSON.parse(job.sourcePaths ?? "[]"),
    destinationIds: JSON.parse(job.destinationIds ?? "[]"),
    retention: JSON.parse(job.retention ?? "{}"),
    excludePatterns: JSON.parse(job.excludePatterns ?? "[]"),
    tags: JSON.parse(job.tags ?? "[]"),
  };
}
