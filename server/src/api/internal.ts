/**
 * Internal API endpoints consumed exclusively by registered agents.
 * Auth: Bearer token (raw apiToken issued during registration).
 * These routes expose decrypted credentials and MUST NOT be user-facing.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db/index.js";
import { agents, backupJobs, destinations } from "../db/schema/index.js";
import { eq, inArray } from "drizzle-orm";
import { decrypt, sha256 } from "../crypto/encryption.js";
import { logger } from "../logger.js";

export const internalRouter = Router();

// ── Agent auth middleware ──────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      agentId?: string;
    }
  }
}

function requireAgentAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const rawToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const agentId = req.params.agentId ?? req.headers["x-agent-id"] as string;

  if (!rawToken || !agentId) {
    res.status(401).json({ error: "Agent authentication required" });
    return;
  }

  const db = getDb();
  const [agent] = db.select({ id: agents.id, apiToken: agents.apiToken })
    .from(agents).where(eq(agents.id, agentId)).all();

  if (!agent || !agent.apiToken || agent.apiToken !== sha256(rawToken)) {
    res.status(401).json({ error: "Invalid agent credentials" });
    return;
  }

  req.agentId = agentId;
  next();
}

// GET /api/internal/agents/:agentId/jobs
// Returns all jobs for this agent with decrypted destination configs and Restic passwords.
internalRouter.get("/agents/:agentId/jobs", requireAgentAuth, (req, res) => {
  const db = getDb();
  const agentId = req.params.agentId;

  const jobs = db.select().from(backupJobs).where(eq(backupJobs.agentId, agentId)).all();

  // Collect all unique destination IDs across all jobs
  const allDestIds = [...new Set(jobs.flatMap((j) => JSON.parse(j.destinationIds ?? "[]") as string[]))];

  // Fetch and decrypt all needed destinations in one query
  const destRows = allDestIds.length > 0
    ? db.select().from(destinations).where(inArray(destinations.id, allDestIds)).all()
    : [];

  const destMap = new Map(destRows.map((d) => {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(decrypt(d.configEncrypted)); } catch { /* ignore */ }
    return [d.id, { id: d.id, name: d.name, type: d.type, config }];
  }));

  const result = jobs.map((job) => {
    const destIds: string[] = JSON.parse(job.destinationIds ?? "[]");
    const jobDestinations = destIds.map((id) => destMap.get(id)).filter(Boolean);

    let resticPassword = "";
    if (job.resticPasswordEncrypted) {
      try { resticPassword = decrypt(job.resticPasswordEncrypted); } catch { /* ignore */ }
    }

    return {
      id: job.id,
      name: job.name,
      sourcePaths: JSON.parse(job.sourcePaths ?? "[]"),
      schedule: job.schedule,
      retention: JSON.parse(job.retention ?? "{}"),
      preScript: job.preScript,
      postScript: job.postScript,
      excludePatterns: JSON.parse(job.excludePatterns ?? "[]"),
      maxRetries: job.maxRetries,
      retryDelaySeconds: job.retryDelaySeconds,
      enabled: job.enabled,
      destinations: jobDestinations,
      resticPassword,
      wormEnabled: job.wormEnabled ?? false,
      wormRetentionDays: job.wormRetentionDays ?? 0,
    };
  });

  logger.debug({ agentId, jobCount: result.length }, "Agent fetched job configs");
  res.json(result);
});

// GET /api/internal/agents/:agentId/jobs/:jobId
// Returns a single job with decrypted destination configs and Restic password.
internalRouter.get("/agents/:agentId/jobs/:jobId", requireAgentAuth, (req, res) => {
  const db = getDb();
  const { agentId, jobId } = req.params;

  const [job] = db.select().from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .all();

  if (!job || job.agentId !== agentId) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const destIds: string[] = JSON.parse(job.destinationIds ?? "[]");
  const destRows = destIds.length > 0
    ? db.select().from(destinations).where(inArray(destinations.id, destIds)).all()
    : [];

  const jobDestinations = destRows.map((d) => {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(decrypt(d.configEncrypted)); } catch { /* ignore */ }
    return { id: d.id, name: d.name, type: d.type, config };
  });

  let resticPassword = "";
  if (job.resticPasswordEncrypted) {
    try { resticPassword = decrypt(job.resticPasswordEncrypted); } catch { /* ignore */ }
  }

  res.json({
    id: job.id,
    name: job.name,
    sourcePaths: JSON.parse(job.sourcePaths ?? "[]"),
    schedule: job.schedule,
    retention: JSON.parse(job.retention ?? "{}"),
    preScript: job.preScript,
    postScript: job.postScript,
    excludePatterns: JSON.parse(job.excludePatterns ?? "[]"),
    maxRetries: job.maxRetries,
    retryDelaySeconds: job.retryDelaySeconds,
    enabled: job.enabled,
    destinations: jobDestinations,
    resticPassword,
    wormEnabled: job.wormEnabled ?? false,
    wormRetentionDays: job.wormRetentionDays ?? 0,
  });
});
