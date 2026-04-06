import { Router } from "express";
import { getDb } from "../db/index.js";
import { snapshots, snapshotLogs, backupJobs, agents, destinations } from "../db/schema/index.js";
import { eq, desc, inArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { sendToAgent, isAgentOnline } from "../websocket/index.js";
import { decrypt } from "../crypto/encryption.js";

export const snapshotsRouter = Router();

// GET /api/snapshots — recent snapshots across all jobs
snapshotsRouter.get("/", requireAuth, (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit as string ?? "100", 10), 500);
  const all = db.select().from(snapshots)
    .orderBy(desc(snapshots.startedAt))
    .limit(limit)
    .all();
  res.json(all);
});

// GET /api/snapshots/:id
snapshotsRouter.get("/:id", requireAuth, (req, res) => {
  const db = getDb();
  const [snap] = db.select().from(snapshots).where(eq(snapshots.id, req.params.id)).all();
  if (!snap) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  res.json(snap);
});

// GET /api/snapshots/:id/logs
snapshotsRouter.get("/:id/logs", requireAuth, (req, res) => {
  const db = getDb();
  const logs = db.select().from(snapshotLogs)
    .where(eq(snapshotLogs.snapshotId, req.params.id))
    .orderBy(snapshotLogs.createdAt)
    .all();
  res.json(logs);
});

// POST /api/snapshots/:id/restore — request restore via agent
snapshotsRouter.post("/:id/restore", requireAuth, (req, res) => {
  const db = getDb();
  const [snap] = db.select().from(snapshots).where(eq(snapshots.id, req.params.id)).all();
  if (!snap) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  if (!snap.resticSnapshotId) {
    res.status(400).json({ error: "No Restic snapshot ID available for this snapshot" });
    return;
  }

  const restorePath = req.body.restorePath as string | undefined;
  if (!restorePath) {
    res.status(400).json({ error: "restorePath is required" });
    return;
  }

  // targetAgentId lets a different agent perform the restore (e.g. disaster recovery
  // where the original host is gone and a new agent has been installed).
  const targetAgentId = (req.body.targetAgentId as string | undefined) ?? snap.agentId;

  // Look up the job to find the destination ID that the agent will need
  const [job] = db.select({ destinationIds: backupJobs.destinationIds })
    .from(backupJobs).where(eq(backupJobs.id, snap.jobId)).all();
  const destinationIds: string[] = JSON.parse(job?.destinationIds ?? "[]");

  const includePaths = Array.isArray(req.body.includePaths) ? req.body.includePaths as string[] : undefined;

  const sent = sendToAgent(targetAgentId, {
    type: "restore",
    snapshotId: snap.id,
    resticSnapshotId: snap.resticSnapshotId,
    restorePath,
    destinationId: destinationIds[0] ?? snap.destinationId ?? "",
    ...(includePaths?.length ? { includePaths } : {}),
  });

  if (!sent) {
    res.status(503).json({ error: "Agent is offline" });
    return;
  }

  res.json({ message: "Restore initiated", targetAgentId });
});

// GET /api/snapshots/:id/files — browse snapshot file tree via agent
snapshotsRouter.get("/:id/files", requireAuth, (req, res) => {
  const db = getDb();
  const [snap] = db.select().from(snapshots).where(eq(snapshots.id, req.params.id)).all();
  if (!snap) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  if (!snap.resticSnapshotId) {
    res.status(400).json({ error: "No Restic snapshot ID available" });
    return;
  }

  // This would typically involve a request to the agent and streaming the response back.
  // For now, delegate to agent via WebSocket and return a pending status.
  const path = (req.query.path as string) || "/";
  const sent = sendToAgent(snap.agentId, {
    type: "list_files",
    resticSnapshotId: snap.resticSnapshotId,
    path,
  });

  if (!sent) {
    res.status(503).json({ error: "Agent is offline" });
    return;
  }

  res.json({ message: "File listing requested. Subscribe to WebSocket for results." });
});

// GET /api/snapshots/:id/restore-agents — list agents that can perform this restore
// Returns all online agents; UI uses this to let the user pick an alternative agent.
snapshotsRouter.get("/:id/restore-agents", requireAuth, (req, res) => {
  const db = getDb();
  const [snap] = db.select({ agentId: snapshots.agentId }).from(snapshots).where(eq(snapshots.id, req.params.id)).all();
  if (!snap) { res.status(404).json({ error: "Snapshot not found" }); return; }

  const allAgents = db.select({ id: agents.id, name: agents.name, hostname: agents.hostname, status: agents.status })
    .from(agents).all()
    .map((a) => ({ ...a, online: isAgentOnline(a.id), isOriginal: a.id === snap.agentId }));

  res.json(allAgents);
});

// DELETE /api/snapshots/:id — forget/prune snapshot
snapshotsRouter.delete("/:id", requireAuth, (req, res) => {
  const db = getDb();
  const [snap] = db.select().from(snapshots).where(eq(snapshots.id, req.params.id)).all();
  if (!snap) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  // ── WORM enforcement ───────────────────────────────────────────────────────
  // Look up the job to check whether WORM is active and compute the unlock date.
  const [job] = db.select({
    wormEnabled: backupJobs.wormEnabled,
    wormRetentionDays: backupJobs.wormRetentionDays,
  }).from(backupJobs).where(eq(backupJobs.id, snap.jobId)).all();

  if (job?.wormEnabled && job.wormRetentionDays > 0) {
    const startedMs = new Date(snap.startedAt).getTime();
    const unlockMs = startedMs + job.wormRetentionDays * 86_400_000;
    const nowMs = Date.now();
    if (nowMs < unlockMs) {
      const unlockDate = new Date(unlockMs).toISOString();
      res.status(423).json({
        error: "WORM lock active: this snapshot cannot be deleted before the retention period expires",
        lockedUntil: unlockDate,
        wormRetentionDays: job.wormRetentionDays,
      });
      return;
    }
  }

  // Per-snapshot lock (set via bulk-lock action)
  if (snap.lockedUntil && new Date(snap.lockedUntil) > new Date()) {
    res.status(423).json({
      error: "Snapshot is individually locked and cannot be deleted before the lock expires",
      lockedUntil: snap.lockedUntil,
    });
    return;
  }

  if (snap.resticSnapshotId) {
    sendToAgent(snap.agentId, {
      type: "forget_snapshot",
      resticSnapshotId: snap.resticSnapshotId,
    });
  }

  db.delete(snapshots).where(eq(snapshots.id, req.params.id)).run();
  res.json({ message: "Snapshot removed" });
});

// POST /api/snapshots/bulk-delete — delete multiple snapshots at once
snapshotsRouter.post("/bulk-delete", requireAuth, (req, res) => {
  const ids: string[] = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array" });
    return;
  }
  if (ids.length > 200) {
    res.status(400).json({ error: "Cannot delete more than 200 snapshots at once" });
    return;
  }

  const db = getDb();
  const rows = db.select().from(snapshots).where(inArray(snapshots.id, ids)).all();

  const skipped: string[] = [];
  const deleted: string[] = [];
  const now = new Date();

  for (const snap of rows) {
    // Check job-level WORM
    const [job] = db.select({ wormEnabled: backupJobs.wormEnabled, wormRetentionDays: backupJobs.wormRetentionDays })
      .from(backupJobs).where(eq(backupJobs.id, snap.jobId)).all();
    if (job?.wormEnabled && job.wormRetentionDays > 0) {
      const unlockMs = new Date(snap.startedAt).getTime() + job.wormRetentionDays * 86_400_000;
      if (Date.now() < unlockMs) { skipped.push(snap.id); continue; }
    }
    // Check per-snapshot lock
    if (snap.lockedUntil && new Date(snap.lockedUntil) > now) {
      skipped.push(snap.id); continue;
    }

    if (snap.resticSnapshotId) {
      sendToAgent(snap.agentId, { type: "forget_snapshot", resticSnapshotId: snap.resticSnapshotId });
    }
    db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
    deleted.push(snap.id);
  }

  res.json({ deleted: deleted.length, skipped: skipped.length, skippedIds: skipped });
});

// POST /api/snapshots/bulk-lock — lock multiple snapshots for N days
snapshotsRouter.post("/bulk-lock", requireAuth, (req, res) => {
  const ids: string[] = req.body?.ids;
  const days: number = req.body?.days;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array" });
    return;
  }
  if (typeof days !== "number" || days < 1 || days > 36500) {
    res.status(400).json({ error: "days must be a number between 1 and 36500" });
    return;
  }
  if (ids.length > 200) {
    res.status(400).json({ error: "Cannot lock more than 200 snapshots at once" });
    return;
  }

  const db = getDb();
  const lockedUntil = new Date(Date.now() + days * 86_400_000).toISOString();

  db.update(snapshots)
    .set({ lockedUntil } as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(inArray(snapshots.id, ids))
    .run();

  res.json({ locked: ids.length, lockedUntil });
});
