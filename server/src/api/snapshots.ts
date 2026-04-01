import { Router } from "express";
import { getDb } from "../db/index.js";
import { snapshots, snapshotLogs, backupJobs, agents } from "../db/schema/index.js";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { sendToAgent } from "../websocket/index.js";

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

  const sent = sendToAgent(snap.agentId, {
    type: "restore",
    snapshotId: snap.id,
    resticSnapshotId: snap.resticSnapshotId,
    restorePath,
    include: req.body.include,
    exclude: req.body.exclude,
  });

  if (!sent) {
    res.status(503).json({ error: "Agent is offline" });
    return;
  }

  res.json({ message: "Restore initiated" });
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

// DELETE /api/snapshots/:id — forget/prune snapshot
snapshotsRouter.delete("/:id", requireAuth, (req, res) => {
  const db = getDb();
  const [snap] = db.select().from(snapshots).where(eq(snapshots.id, req.params.id)).all();
  if (!snap) {
    res.status(404).json({ error: "Snapshot not found" });
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
