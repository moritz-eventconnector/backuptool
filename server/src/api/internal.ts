/**
 * Internal API endpoints consumed exclusively by registered agents.
 * Auth: Bearer token (raw apiToken issued during registration).
 * These routes expose decrypted credentials and MUST NOT be user-facing.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { createReadStream, existsSync } from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { agents, backupJobs, destinations } from "../db/schema/index.js";
import { eq, inArray } from "drizzle-orm";
import { decrypt, sha256 } from "../crypto/encryption.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

/** Compute SHA-256 hex digest of a file, or null if the file doesn't exist. */
async function sha256File(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

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
    // Inject the per-job repo suffix into each destination's config so the agent
    // can construct the correct job-isolated repository URL.
    const jobDestinations = destIds.map((id) => {
      const d = destMap.get(id);
      if (!d) return null;
      return {
        ...d,
        config: {
          ...d.config,
          ...(job.resticRepoSuffix ? { _repoSuffix: job.resticRepoSuffix } : {}),
        },
      };
    }).filter(Boolean);

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
    if (job.resticRepoSuffix) config._repoSuffix = job.resticRepoSuffix;
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

// GET /api/internal/agents/:agentId/update/hash?os=linux&arch=amd64
// Agent calls this on startup to check if a newer binary is available.
internalRouter.get("/agents/:agentId/update/hash", requireAgentAuth, async (req, res) => {
  const os = (req.query.os as string) || "linux";
  const arch = (req.query.arch as string) || "amd64";
  const ext = os === "windows" ? ".exe" : "";
  const filename = `agent-${os}-${arch}${ext}`;
  const localPath = path.join(config.dataDir, "binaries", filename);
  const hash = await sha256File(localPath);
  if (!hash) {
    res.status(404).json({ error: "Binary not available on server" });
    return;
  }
  res.json({ hash, os, arch });
});

// GET /api/internal/agents/:agentId/update/binary?os=linux&arch=amd64
// Agent downloads the updated binary when hash differs.
internalRouter.get("/agents/:agentId/update/binary", requireAgentAuth, (req, res) => {
  const os = (req.query.os as string) || "linux";
  const arch = (req.query.arch as string) || "amd64";
  const ext = os === "windows" ? ".exe" : "";
  const filename = `agent-${os}-${arch}${ext}`;
  const localPath = path.join(config.dataDir, "binaries", filename);
  if (!existsSync(localPath)) {
    res.status(404).json({ error: "Binary not available on server" });
    return;
  }
  res.download(localPath, filename);
});
