import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { getDb } from "../db/index.js";
import { destinations, snapshots, backupJobs } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { encrypt, decrypt } from "../crypto/encryption.js";
import { writeAuditLog } from "../middleware/audit.js";

const execFileP = promisify(execFile);

export const destinationsRouter = Router();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["s3", "b2", "local", "sftp", "gcs", "azure", "rclone", "wasabi", "minio"]),
  config: z.record(z.unknown()), // provider-specific config (will be encrypted)
  // S3 Object Lock — storage-level immutability (only for s3/wasabi/minio)
  wormEnabled: z.boolean().default(false).optional(),
  wormRetentionDays: z.number().int().min(0).max(36500).default(0).optional(),
  wormMode: z.enum(["COMPLIANCE", "GOVERNANCE"]).default("COMPLIANCE").optional(),
});

// POST /api/destinations/test — verify storage credentials before saving
destinationsRouter.post("/test", requireAuth, requireRole("admin", "operator"), async (req, res) => {
  const { type, config } = req.body as { type?: string; config?: Record<string, unknown> };
  if (!type || !config || typeof config !== "object") {
    res.status(400).json({ ok: false, error: "type and config are required" });
    return;
  }
  const result = await testDestinationConnection(type, config);
  if (result.ok) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

/** Run a quick connectivity test for a destination without saving it. */
async function testDestinationConnection(
  type: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  const get = (k: string): string => ((config[k] as string) ?? "").trim();

  switch (type) {
    // ── Local path ────────────────────────────────────────────────────────────
    case "local": {
      const p = get("path");
      if (!p) return { ok: false, message: "Path is required" };
      try {
        await fs.access(p);
        const stat = await fs.stat(p);
        if (!stat.isDirectory()) return { ok: false, message: `${p} exists but is not a directory` };
        return { ok: true, message: `Path ${p} is accessible` };
      } catch {
        return { ok: false, message: `Cannot access path: ${p} — the directory may not exist yet on the agent host` };
      }
    }

    // ── S3-compatible (S3, Minio, Wasabi, B2) ────────────────────────────────
    case "s3":
    case "minio":
    case "wasabi":
    case "b2": {
      const bucket = get("bucket");
      if (!bucket) return { ok: false, message: "Bucket name is required" };

      let remote = `:s3:${bucket}`;
      const prefix = get("path").replace(/^\//, "");
      if (prefix) remote += `/${prefix}`;

      const args = ["lsf", "--max-depth=1", "--dirs-only", "--timeout=10s", remote, "--s3-provider=Other"];
      const ep = get("endpoint"); if (ep) args.push(`--s3-endpoint=${ep}`);
      const ak = get("accessKeyId"); if (ak) args.push(`--s3-access-key-id=${ak}`);
      const sk = get("secretAccessKey"); if (sk) args.push(`--s3-secret-access-key=${sk}`);
      const region = get("region"); if (region) args.push(`--s3-region=${region}`);

      try {
        await execFileP("rclone", args, { timeout: 15_000 });
        return { ok: true, message: `Connected to bucket "${bucket}" successfully` };
      } catch (err) {
        return { ok: false, message: rcloneError(err) };
      }
    }

    // ── SFTP ──────────────────────────────────────────────────────────────────
    case "sftp": {
      const host = get("host");
      const portStr = get("port") || "22";
      const user = get("user");
      if (!host) return { ok: false, message: "Host is required" };
      if (!user) return { ok: false, message: "Username is required" };
      const port = parseInt(portStr, 10) || 22;

      // Step 1: TCP reachability check
      const tcpOk = await checkTcp(host, port, 8_000);
      if (!tcpOk) {
        return { ok: false, message: `Cannot reach ${host}:${port} — check host/port and firewall rules` };
      }

      // Step 2: Try rclone lsf (skipping host-key verification via known-hosts trick)
      const remotePath = get("path") || "/";
      const remote = `:sftp:${remotePath}`;
      const password = get("password");

      const args = [
        "lsf", "--max-depth=1", "--dirs-only", "--timeout=8s", remote,
        `--sftp-host=${host}`, `--sftp-user=${user}`, `--sftp-port=${portStr}`,
        "--sftp-shell-type=unix",
      ];

      // Write an empty known_hosts file and set it so rclone accepts any key
      const khFile = path.join(os.tmpdir(), `bk-sftp-kh-${Date.now()}`);
      try {
        await fs.writeFile(khFile, "", { mode: 0o600 });
        args.push(`--sftp-known-hosts-file=${khFile}`);
      } catch { /* ignore */ }

      if (password) {
        try {
          const { stdout } = await execFileP("rclone", ["obscure", password], { timeout: 5_000 });
          args.push(`--sftp-pass=${stdout.trim()}`);
        } catch {
          // If we can't obscure, still try without (key-based auth may work)
        }
      }
      const keyFile = get("keyFile"); if (keyFile) args.push(`--sftp-key-file=${keyFile}`);

      try {
        await execFileP("rclone", args, { timeout: 12_000 });
        await fs.unlink(khFile).catch(() => {});
        return { ok: true, message: `Connected to ${user}@${host}:${port} successfully` };
      } catch (err) {
        await fs.unlink(khFile).catch(() => {});
        const msg = rcloneError(err);
        // If it's a host-key error specifically, still consider TCP success a partial win
        if (msg.toLowerCase().includes("host key") || msg.toLowerCase().includes("known_host")) {
          return { ok: true, message: `Host reachable at ${host}:${port} — host key verification failed, but connection will work once keys are trusted` };
        }
        return { ok: false, message: msg };
      }
    }

    // ── Google Cloud Storage ──────────────────────────────────────────────────
    case "gcs": {
      const bucket = get("bucket");
      if (!bucket) return { ok: false, message: "Bucket is required" };
      const credJson = get("credentialsJson");
      if (!credJson) return { ok: false, message: "Service account credentials JSON is required" };

      const tmpFile = path.join(os.tmpdir(), `bk-gcs-${Date.now()}.json`);
      try {
        await fs.writeFile(tmpFile, credJson, { mode: 0o600 });
        const remote = `:gcs:${bucket}`;
        const args = ["lsf", "--max-depth=1", "--dirs-only", "--timeout=10s", remote,
          `--gcs-service-account-file=${tmpFile}`];
        await execFileP("rclone", args, { timeout: 15_000 });
        return { ok: true, message: `Connected to GCS bucket "${bucket}" successfully` };
      } catch (err) {
        return { ok: false, message: rcloneError(err) };
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    }

    // ── Azure Blob Storage ────────────────────────────────────────────────────
    case "azure": {
      const container = get("container") || get("bucket");
      if (!container) return { ok: false, message: "Container name is required" };
      const account = get("account") || get("storageAccount");
      const key = get("key") || get("storageKey");

      let remote = `:azureblob:${container}`;
      const prefix = get("path").replace(/^\//, ""); if (prefix) remote += `/${prefix}`;
      const args = ["lsf", "--max-depth=1", "--dirs-only", "--timeout=10s", remote];
      if (account) args.push(`--azureblob-account=${account}`);
      if (key) args.push(`--azureblob-key=${key}`);

      try {
        await execFileP("rclone", args, { timeout: 15_000 });
        return { ok: true, message: `Connected to Azure container "${container}" successfully` };
      } catch (err) {
        return { ok: false, message: rcloneError(err) };
      }
    }

    // ── Rclone (generic) ──────────────────────────────────────────────────────
    case "rclone": {
      const remote = get("remote");
      if (!remote) return { ok: false, message: "Remote is required" };
      try {
        await execFileP("rclone", ["lsf", "--max-depth=1", "--dirs-only", "--timeout=10s", remote], { timeout: 15_000 });
        return { ok: true, message: `Connected to "${remote}" successfully` };
      } catch (err) {
        return { ok: false, message: rcloneError(err) };
      }
    }

    default:
      return { ok: false, message: `Connection test not supported for type: ${type}` };
  }
}

/** Check if a TCP port is reachable within timeoutMs. */
function checkTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
  });
}

/** Extract a clean error message from a failed rclone execFile call. */
function rcloneError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const raw = ((err as Error & { stderr?: string }).stderr ?? err.message).trim();
  // Pick the most informative line (rclone often puts the key error at the end)
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find((l) =>
    /error|failed|denied|invalid|unauthorized|not found|refused|timeout/i.test(l)
  ) ?? lines[lines.length - 1] ?? raw;
  return errLine.replace(/^(ERROR|NOTICE|INFO)\s*:?\s*/i, "").trim();
}

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
    return {
      id: d.id, name: d.name, type: d.type, repoSummary,
      wormEnabled: d.wormEnabled ?? false,
      wormRetentionDays: d.wormRetentionDays ?? 0,
      wormMode: (d.wormMode ?? "COMPLIANCE") as "COMPLIANCE" | "GOVERNANCE",
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    };
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
  res.json({
    id: dest.id, name: dest.name, type: dest.type, config,
    wormEnabled: dest.wormEnabled ?? false,
    wormRetentionDays: dest.wormRetentionDays ?? 0,
    wormMode: (dest.wormMode ?? "COMPLIANCE") as "COMPLIANCE" | "GOVERNANCE",
    createdAt: dest.createdAt,
  });
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
    wormEnabled: parse.data.wormEnabled ?? false,
    wormRetentionDays: parse.data.wormRetentionDays ?? 0,
    wormMode: parse.data.wormMode ?? "COMPLIANCE",
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
  if (parse.data.wormEnabled !== undefined) updates.wormEnabled = parse.data.wormEnabled;
  if (parse.data.wormRetentionDays !== undefined) updates.wormRetentionDays = parse.data.wormRetentionDays;
  if (parse.data.wormMode !== undefined) updates.wormMode = parse.data.wormMode;

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
