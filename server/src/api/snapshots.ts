import { Router } from "express";
import { getDb } from "../db/index.js";
import { snapshots, snapshotLogs, backupJobs, agents, destinations } from "../db/schema/index.js";
import { eq, desc } from "drizzle-orm";
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

  const sent = sendToAgent(targetAgentId, {
    type: "restore",
    snapshotId: snap.id,
    resticSnapshotId: snap.resticSnapshotId,
    restorePath,
    destinationId: destinationIds[0] ?? snap.destinationId ?? "",
    include: req.body.include,
    exclude: req.body.exclude,
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

  if (snap.resticSnapshotId) {
    sendToAgent(snap.agentId, {
      type: "forget_snapshot",
      resticSnapshotId: snap.resticSnapshotId,
    });
  }

  db.delete(snapshots).where(eq(snapshots.id, req.params.id)).run();
  res.json({ message: "Snapshot removed" });
});
