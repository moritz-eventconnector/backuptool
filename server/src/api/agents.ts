import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { agents, backupJobs } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { randomToken, sha256 } from "../crypto/encryption.js";
import { issueAgentCert, getCACert } from "../crypto/certs.js";
import { logger } from "../logger.js";
import { sendToAgent, isAgentOnline } from "../websocket/index.js";

export const agentsRouter = Router();

// GET /api/agents
agentsRouter.get("/", requireAuth, (_req, res) => {
  const db = getDb();
  const all = db.select().from(agents).all();
  res.json(all);
});

// GET /api/agents/:id
agentsRouter.get("/:id", requireAuth, (req, res) => {
  const db = getDb();
  const [agent] = db.select().from(agents).where(eq(agents.id, req.params.id)).all();
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(agent);
});

// POST /api/agents/token — generate a registration token for a new agent
agentsRouter.post("/token", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const token = randomToken(32);
  // Store token temporarily in a new agent record (pre-registration)
  const db = getDb();
  const agentId = nanoid();
  db.insert(agents).values({
    id: agentId,
    name: (req.body.name as string) || "Unnamed Agent",
    os: "unknown",
    arch: "unknown",
    hostname: "pending",
    registrationToken: token,
    status: "offline",
  }).run();

  res.json({ agentId, registrationToken: token });
});

// POST /api/agents/register — called by agent on first start
const registerSchema = z.object({
  agentId: z.string().min(1),
  registrationToken: z.string().min(1),
  name: z.string().min(1).max(100),
  os: z.string(),
  arch: z.string(),
  hostname: z.string(),
  version: z.string().optional(),
  ip: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

agentsRouter.post("/register", async (req, res) => {
  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const [existing] = db.select().from(agents).where(eq(agents.id, parse.data.agentId)).all();

  if (!existing) {
    res.status(404).json({ error: "Agent ID not found. Generate a registration token first." });
    return;
  }

  if (existing.registrationToken !== parse.data.registrationToken) {
    res.status(401).json({ error: "Invalid registration token" });
    return;
  }

  // Issue mTLS client certificate
  const { certPem, keyPem, fingerprint } = await issueAgentCert(parse.data.agentId);

  // Generate a persistent API token for WebSocket + internal API auth
  const rawApiToken = randomToken(32);
  const apiTokenHash = sha256(rawApiToken);

  db.update(agents).set({
    name: parse.data.name,
    os: parse.data.os,
    arch: parse.data.arch,
    hostname: parse.data.hostname,
    version: parse.data.version ?? "unknown",
    ip: parse.data.ip,
    tags: JSON.stringify(parse.data.tags ?? []),
    certFingerprint: fingerprint,
    apiToken: apiTokenHash,
    registrationToken: null, // revoke registration token after use
    status: "offline",
  }).where(eq(agents.id, parse.data.agentId)).run();

  logger.info({ agentId: parse.data.agentId, hostname: parse.data.hostname }, "Agent registered");

  res.json({
    agentId: parse.data.agentId,
    certPem,
    keyPem,
    caCert: getCACert(),
    apiToken: rawApiToken, // raw (unhashed) — stored only by agent
  });
});

// POST /api/agents/:id/update — push update command to a running agent
agentsRouter.post("/:id/update", requireAuth, requireRole("admin", "operator"), (req, res) => {
  if (!isAgentOnline(req.params.id)) {
    res.status(503).json({ error: "Agent is offline. Restart the agent service manually and it will auto-update on startup." });
    return;
  }
  const sent = sendToAgent(req.params.id, { type: "update_binary" });
  if (!sent) {
    res.status(503).json({ error: "Failed to send update command" });
    return;
  }
  res.json({ message: "Update command sent. Agent will restart with the new binary in a few seconds." });
});

// DELETE /api/agents/:id
agentsRouter.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();
  const [agent] = db.select().from(agents).where(eq(agents.id, req.params.id)).all();
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Tell the agent to uninstall itself if it's currently connected.
  // Best-effort — if the agent is offline it will fail to reconnect once
  // its DB record and API token are gone.
  const wasOnline = isAgentOnline(req.params.id);
  if (wasOnline) {
    sendToAgent(req.params.id, { type: "uninstall" });
  }

  db.delete(agents).where(eq(agents.id, req.params.id)).run();
  logger.info({ agentId: req.params.id, uninstallSent: wasOnline }, "Agent deleted");
  res.json({ message: "Agent deleted", uninstallSent: wasOnline });
});

// PATCH /api/agents/:id
agentsRouter.patch("/:id", requireAuth, requireRole("admin", "operator"), (req, res) => {
  const db = getDb();
  const allowed = ["name", "tags"];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in req.body) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }
  if (updates.tags) updates.tags = JSON.stringify(updates.tags);
  db.update(agents).set(updates as Parameters<ReturnType<typeof db.update>["set"]>[0]).where(eq(agents.id, req.params.id)).run();
  res.json({ message: "Agent updated" });
});

// GET /api/agents/:id/discovered — get discovered services for an agent
agentsRouter.get("/:id/discovered", requireAuth, (req, res) => {
  const db = getDb();
  const [agent] = db.select({ discoveredServices: agents.discoveredServices }).from(agents).where(eq(agents.id, req.params.id)).all();
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const services = agent.discoveredServices ? JSON.parse(agent.discoveredServices) : [];
  res.json(services);
});

// GET /api/agents/:id/jobs — get all backup jobs for an agent
agentsRouter.get("/:id/jobs", requireAuth, (req, res) => {
  const db = getDb();
  const jobs = db.select().from(backupJobs).where(eq(backupJobs.agentId, req.params.id)).all();
  res.json(jobs);
});
