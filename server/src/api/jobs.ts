import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { backupJobs, agents, snapshots, notificationSettings, destinations } from "../db/schema/index.js";
import { eq, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { sendToAgent } from "../websocket/index.js";
import { encrypt, randomToken, decrypt } from "../crypto/encryption.js";
import { sendBackupNotification } from "../notifications/email.js";
import { sendWebhookNotification, type WebhookType } from "../notifications/webhook.js";
import { logger } from "../logger.js";
import { checkOverdueBackups } from "../alerts/overdue.js";
import { writeAuditLog } from "../middleware/audit.js";

export const jobsRouter = Router();

// GET /api/jobs/overdue — returns jobs that have missed their schedule
jobsRouter.get("/overdue", requireAuth, async (_req, res) => {
  const overdue = await checkOverdueBackups();
  res.json(overdue);
});

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
  retention: retentionSchema.optional().default({}),
  preScript: z.string().optional(),
  postScript: z.string().optional(),
  excludePatterns: z.array(z.string()).default([]),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryDelaySeconds: z.number().int().min(0).default(60),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  wormEnabled: z.boolean().default(false),
  wormRetentionDays: z.number().int().min(0).max(36500).default(0),
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
    const flat = parse.error.flatten();
    const fieldErrors = Object.entries(flat.fieldErrors)
      .map(([f, errs]) => `${f}: ${(errs as string[]).join(", ")}`)
      .join("; ");
    const msg = fieldErrors || flat.formErrors.join("; ") || "Invalid input";
    logger.warn({ errors: flat, body: { ...req.body, preScript: req.body.preScript?.slice?.(0, 200), postScript: req.body.postScript?.slice?.(0, 200) } }, "Job creation validation failed");
    res.status(400).json({ error: msg, details: flat });
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

  // Per-job repo suffix: isolates this job's restic repository within a shared destination bucket.
  // Example: two jobs using "s3:endpoint/bucket" get repos at "s3:endpoint/bucket/jXxYzW" and
  // "s3:endpoint/bucket/kAbCdE" so they never interfere with each other.
  const resticRepoSuffix = nanoid(8);

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
    resticRepoSuffix,
    preScript: parse.data.preScript,
    postScript: parse.data.postScript,
    excludePatterns: JSON.stringify(parse.data.excludePatterns),
    maxRetries: parse.data.maxRetries,
    retryDelaySeconds: parse.data.retryDelaySeconds,
    tags: JSON.stringify(parse.data.tags),
    enabled: parse.data.enabled,
    wormEnabled: parse.data.wormEnabled,
    wormRetentionDays: parse.data.wormRetentionDays,
  }).run();

  // Push updated job list to agent via WebSocket
  sendToAgent(parse.data.agentId, { type: "sync_jobs" });

  const [created] = db.select().from(backupJobs).where(eq(backupJobs.id, id)).all();
  writeAuditLog(req, "create_job", `job:${id}`, { name: parse.data.name, agentId: parse.data.agentId });
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
  if ("wormEnabled" in parse.data) updates.wormEnabled = parse.data.wormEnabled;
  if ("wormRetentionDays" in parse.data) updates.wormRetentionDays = parse.data.wormRetentionDays;

  db.update(backupJobs)
    .set(updates as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(backupJobs.id, req.params.id))
    .run();

  sendToAgent(job.agentId, { type: "sync_jobs" });
  writeAuditLog(req, "update_job", `job:${req.params.id}`, { name: job.name });
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
  writeAuditLog(req, "delete_job", `job:${req.params.id}`, { name: job.name });
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

  // Fire "on start" notifications (fire-and-forget)
  try {
    const [notifRow] = db.select().from(notificationSettings).all();
    const [agentRow] = db.select({ name: agents.name }).from(agents).where(eq(agents.id, job.agentId)).all();
    const jobName = job.name;
    const agentName = agentRow?.name ?? job.agentId;
    const startedAt = new Date().toISOString();

    if (notifRow?.emailEnabled && notifRow.notifyOnStart) {
      const recipients: string[] = JSON.parse(notifRow.emailRecipients ?? "[]");
      if (recipients.length > 0) {
        let smtpPass: string | undefined;
        if (notifRow.smtpPassEncrypted) {
          try { smtpPass = decrypt(notifRow.smtpPassEncrypted); } catch { /* ignore */ }
        }
        sendBackupNotification(recipients, { jobName, agentName, status: "started", startedAt, snapshotId }, {
          smtpHost: notifRow.smtpHost, smtpPort: notifRow.smtpPort,
          smtpUser: notifRow.smtpUser, smtpFrom: notifRow.smtpFrom, smtpPass,
        }).catch((err) => logger.error({ err }, "Start email notification failed"));
      }
    }

    if (notifRow?.webhookEnabled && notifRow.webhookUrl && notifRow.webhookOnStart) {
      sendWebhookNotification(
        notifRow.webhookUrl,
        (notifRow.webhookType ?? "generic") as WebhookType,
        { jobName, agentName, status: "started", startedAt, snapshotId },
      ).catch((err) => logger.error({ err }, "Start webhook notification failed"));
    }
  } catch (err) {
    logger.error({ err }, "Error preparing start notifications");
  }

  writeAuditLog(req, "run_job", `job:${req.params.id}`, { name: job.name, snapshotId });
  res.json({ snapshotId, message: "Backup triggered" });
});

// POST /api/jobs/:id/verify — trigger deep data integrity check (restic check --read-data-subset=25%)
jobsRouter.post("/:id/verify", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const db = getDb();
  const [job] = db.select().from(backupJobs).where(eq(backupJobs.id, req.params.id)).all();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Fetch destinations with decrypted configs to send to agent
  const destIds: string[] = JSON.parse(job.destinationIds ?? "[]");
  const destRows = destIds.map((id) => {
    const [d] = db.select().from(destinations).where(eq(destinations.id, id)).all();
    if (!d) return null;
    const config = JSON.parse(decrypt(d.configEncrypted));
    return { id: d.id, type: d.type, name: d.name, config };
  }).filter(Boolean);

  const password = job.resticPasswordEncrypted ? decrypt(job.resticPasswordEncrypted) : "";

  const sent = sendToAgent(job.agentId, {
    type: "verify_backup",
    jobId: job.id,
    password,
    destinations: destRows,
  });

  if (!sent) {
    res.status(503).json({ error: "Agent is offline" });
    return;
  }

  writeAuditLog(req, "verify_backup", `job:${req.params.id}`, { name: job.name });
  res.json({ message: "Deep verification started" });
});

// POST /api/jobs/:id/rotate-key — rotate the restic repository encryption key
jobsRouter.post("/:id/rotate-key", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();
  const [job] = db.select().from(backupJobs).where(eq(backupJobs.id, req.params.id)).all();
  if (!job || !job.resticPasswordEncrypted) {
    res.status(404).json({ error: "Job not found or has no password" });
    return;
  }

  const oldPassword = decrypt(job.resticPasswordEncrypted);
  const newPassword = randomToken(28);
  const newPasswordEncrypted = encrypt(newPassword);

  // Store new password as "pending" — WS handler commits it on agent success
  db.update(backupJobs)
    .set({ resticPasswordPending: newPasswordEncrypted } as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(backupJobs.id, req.params.id))
    .run();

  const destIds: string[] = JSON.parse(job.destinationIds ?? "[]");
  const destRows = destIds.map((id) => {
    const [d] = db.select().from(destinations).where(eq(destinations.id, id)).all();
    if (!d) return null;
    const config = JSON.parse(decrypt(d.configEncrypted));
    return { id: d.id, type: d.type, name: d.name, config };
  }).filter(Boolean);

  const sent = sendToAgent(job.agentId, {
    type: "rotate_key",
    jobId: job.id,
    oldPassword,
    newPassword,
    destinations: destRows,
  });

  if (!sent) {
    // Rollback pending
    db.update(backupJobs)
      .set({ resticPasswordPending: null } as Parameters<ReturnType<typeof db.update>["set"]>[0])
      .where(eq(backupJobs.id, req.params.id))
      .run();
    res.status(503).json({ error: "Agent is offline" });
    return;
  }

  writeAuditLog(req, "rotate_key", `job:${req.params.id}`, { name: job.name });
  res.json({ message: "Key rotation started — agent will update the repository" });
});

// POST /api/jobs/:id/reset-repo — assign a new resticRepoSuffix to isolate this job's repo path.
// Orphans all existing snapshots for this job (they used the old path/password).
jobsRouter.post("/:id/reset-repo", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const db = getDb();
  const [job] = db.select().from(backupJobs).where(eq(backupJobs.id, req.params.id)).all();
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const newSuffix = nanoid(8);
  db.update(backupJobs)
    .set({ resticRepoSuffix: newSuffix } as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(backupJobs.id, job.id))
    .run();

  // Orphan existing snapshots — they were created at the old repo path
  db.update(snapshots)
    .set({ status: "orphaned" } as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(snapshots.jobId, job.id))
    .run();

  writeAuditLog(req, "job.reset_repo", `job:${job.id}`, { jobName: job.name, newSuffix });
  res.json({ message: "Repo path reset. A new isolated repository will be initialised on the next backup.", newSuffix });
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
  const { resticPasswordEncrypted: _pw, resticPasswordPending: _ppw, ...rest } = job;
  return {
    ...rest,
    sourcePaths: JSON.parse(job.sourcePaths ?? "[]"),
    destinationIds: JSON.parse(job.destinationIds ?? "[]"),
    retention: JSON.parse(job.retention ?? "{}"),
    excludePatterns: JSON.parse(job.excludePatterns ?? "[]"),
    tags: JSON.parse(job.tags ?? "[]"),
  };
}
