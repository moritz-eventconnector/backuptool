/**
 * WebSocket server for real-time bidirectional communication with agents
 * and live progress streaming to the web UI.
 *
 * Message types (agent → server):
 *   { type: "register",    agentId, token }
 *   { type: "progress",    snapshotId, percent, filesNew, filesDone, sizeTotal, sizeDone }
 *   { type: "log",         snapshotId, level, message }
 *   { type: "snapshot_done", snapshotId, status, resticSnapshotId, sizeBytes, fileCount, durationSeconds }
 *   { type: "heartbeat" }
 *
 * Message types (server → agent):
 *   { type: "run_job",     jobId, ... }
 *   { type: "cancel_job",  snapshotId }
 *   { type: "ack" }
 *
 * Message types (server → UI clients):
 *   { type: "agent_status", agentId, status }
 *   { type: "progress",     snapshotId, ... }
 *   { type: "log",          snapshotId, ... }
 *   { type: "snapshot_done", snapshotId, ... }
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "../logger.js";
import { getDb } from "../db/index.js";
import { agents, snapshots, snapshotLogs, notificationSettings, backupJobs } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sha256, decrypt } from "../crypto/encryption.js";
import { sendBackupNotification } from "../notifications/email.js";
import { sendWebhookNotification, type WebhookType } from "../notifications/webhook.js";

// Map: agentId → WebSocket connection
const agentConnections = new Map<string, WebSocket>();
// Map: WebSocket → agentId (reverse lookup for cleanup)
const socketToAgent = new Map<WebSocket, string>();
// Set of UI WebSocket connections (browser clients)
const uiConnections = new Set<WebSocket>();

export function initWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let identified = false;
    let isUi = false;

    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on("message", async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // ── Identification ──────────────────────────────────────────────
      if (!identified) {
        if (msg.type === "agent_connect") {
          const agentId = msg.agentId as string;
          const token = msg.token as string;

          // Verify agent API token (SHA-256 hash comparison)
          const db = getDb();
          const [agent] = db.select().from(agents).where(eq(agents.id, agentId)).all();
          if (!agent || !agent.apiToken || agent.apiToken !== sha256(token)) {
            ws.close(4001, "Unauthorized");
            return;
          }

          identified = true;
          agentConnections.set(agentId, ws);
          socketToAgent.set(ws, agentId);

          // Mark agent online
          db.update(agents)
            .set({ status: "online", lastSeen: new Date().toISOString() })
            .where(eq(agents.id, agentId))
            .run();

          broadcastToUi({ type: "agent_status", agentId, status: "online" });
          ws.send(JSON.stringify({ type: "ack", message: "Connected" }));
          logger.info({ agentId }, "Agent connected via WebSocket");
        } else if (msg.type === "ui_connect") {
          // UI clients connect with a valid access token
          // (token verified in HTTP upgrade middleware — here we trust them)
          identified = true;
          isUi = true;
          uiConnections.add(ws);
          ws.send(JSON.stringify({ type: "ack", message: "UI connected" }));
        }
        return;
      }

      // ── Agent messages ──────────────────────────────────────────────
      if (!isUi) {
        const agentId = socketToAgent.get(ws)!;

        if (msg.type === "snapshot_start") {
          // Agent-initiated backup (from its own cron schedule) — create the snapshot record
          const db = getDb();
          const snapshotId = msg.snapshotId as string;
          const jobId = msg.jobId as string;
          if (snapshotId && jobId) {
            db.insert(snapshots).values({
              id: snapshotId,
              jobId,
              agentId,
              status: "running",
            }).run();
            db.update(agents).set({ status: "busy" }).where(eq(agents.id, agentId)).run();
            broadcastToUi({ type: "snapshot_start", agentId, snapshotId, jobId });
          }
          return;
        }

        if (msg.type === "discovered_services") {
          const db = getDb();
          db.update(agents)
            .set({ discoveredServices: JSON.stringify(msg.services ?? []) })
            .where(eq(agents.id, agentId))
            .run();
          logger.info({ agentId }, "Stored discovered services");
          return;
        }

        if (msg.type === "heartbeat") {
          const db = getDb();
          db.update(agents)
            .set({ lastSeen: new Date().toISOString(), status: "online" })
            .where(eq(agents.id, agentId))
            .run();
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (msg.type === "progress") {
          broadcastToUi({ type: "progress", agentId, ...msg });
          return;
        }

        if (msg.type === "log") {
          const db = getDb();
          const snapshotId = msg.snapshotId as string;
          if (snapshotId) {
            db.insert(snapshotLogs).values({
              id: nanoid(),
              snapshotId,
              level: (msg.level as string) ?? "info",
              message: msg.message as string,
            }).run();
          }
          broadcastToUi({ type: "log", agentId, ...msg });
          return;
        }

        if (msg.type === "restore_progress") {
          broadcastToUi({ type: "restore_progress", agentId, ...msg });
          return;
        }

        if (msg.type === "restore_result") {
          const snapshotId = msg.snapshotId as string;
          const status = msg.status as string;
          const restorePath = msg.restorePath as string;
          const errorMessage = msg.errorMessage as string | undefined;
          logger.info({ agentId, snapshotId, status, restorePath }, "Restore result received");
          if (snapshotId) {
            const db = getDb();
            db.insert(snapshotLogs).values({
              id: nanoid(),
              snapshotId,
              level: status === "success" ? "info" : "error",
              message: status === "success"
                ? `Restore completed successfully → ${restorePath}`
                : `Restore failed: ${errorMessage}`,
            }).run();
          }
          broadcastToUi({ type: "restore_result", agentId, ...msg });
          return;
        }

        if (msg.type === "check_result") {
          const db = getDb();
          const snapshotId = msg.snapshotId as string;
          const checkStatus = msg.status as string; // "passed" | "failed"
          const checkMessage = (msg.message as string) ?? "";
          const destinationId = msg.destinationId as string;

          if (snapshotId) {
            // Store check result as a snapshot log entry
            db.insert(snapshotLogs).values({
              id: nanoid(),
              snapshotId,
              level: checkStatus === "passed" ? "info" : "error",
              message: checkStatus === "passed"
                ? `Integrity check passed${destinationId ? ` (dest: ${destinationId.slice(0, 8)})` : ""}`
                : `Integrity check FAILED: ${checkMessage}`,
            }).run();

            // Persist check status; if failed, downgrade snapshot to "warning"
            const snapUpdate: Record<string, unknown> = { integrityCheckStatus: checkStatus };
            if (checkStatus === "failed") {
              // Only downgrade from success — don't overwrite a "failed" backup status
              const [cur] = db.select({ status: snapshots.status }).from(snapshots).where(eq(snapshots.id, snapshotId)).all();
              if (cur?.status === "success") snapUpdate.status = "warning";
            }
            db.update(snapshots)
              .set(snapUpdate as Parameters<ReturnType<typeof db.update>["set"]>[0])
              .where(eq(snapshots.id, snapshotId))
              .run();

            // Send notification on check failure (use existing email/webhook infra)
            if (checkStatus === "failed") {
              try {
                const [notifRow] = db.select().from(notificationSettings).all();
                if (notifRow?.emailEnabled && notifRow.notifyOnFailure) {
                  const recipients: string[] = JSON.parse(notifRow.emailRecipients ?? "[]");
                  if (recipients.length > 0) {
                    const [snap] = db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).all();
                    const [job] = snap?.jobId
                      ? db.select({ name: backupJobs.name }).from(backupJobs).where(eq(backupJobs.id, snap.jobId)).all()
                      : [];
                    const [agentRow] = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).all();
                    let smtpPass: string | undefined;
                    if (notifRow.smtpPassEncrypted) {
                      try { smtpPass = decrypt(notifRow.smtpPassEncrypted); } catch { /* ignore */ }
                    }
                    sendBackupNotification(recipients, {
                      jobName: job?.name ?? snap?.jobId ?? "unknown",
                      agentName: agentRow?.name ?? agentId,
                      status: "failed",
                      startedAt: snap?.startedAt ?? new Date().toISOString(),
                      errorMessage: `Repository integrity check failed: ${checkMessage}`,
                      snapshotId,
                    }, {
                      smtpHost: notifRow.smtpHost,
                      smtpPort: notifRow.smtpPort,
                      smtpUser: notifRow.smtpUser,
                      smtpFrom: notifRow.smtpFrom,
                      smtpPass,
                    }).catch((err) => logger.error({ err }, "Integrity check alert email failed"));
                  }
                }
              } catch (err) {
                logger.error({ err }, "Error sending integrity check failure notification");
              }

              // Webhook
              try {
                const [notifRow] = db.select().from(notificationSettings).all();
                if (notifRow?.webhookEnabled && notifRow.webhookUrl && notifRow.webhookOnFailure) {
                  const [snap] = db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).all();
                  const [job] = snap?.jobId
                    ? db.select({ name: backupJobs.name }).from(backupJobs).where(eq(backupJobs.id, snap.jobId)).all()
                    : [];
                  const [agentRow] = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).all();
                  const { sendWebhookNotification } = await import("../notifications/webhook.js");
                  sendWebhookNotification(
                    notifRow.webhookUrl,
                    (notifRow.webhookType ?? "generic") as import("../notifications/webhook.js").WebhookType,
                    {
                      jobName: job?.name ?? snap?.jobId ?? "unknown",
                      agentName: agentRow?.name ?? agentId,
                      status: "failed",
                      startedAt: snap?.startedAt ?? new Date().toISOString(),
                      errorMessage: `Repository integrity check failed: ${checkMessage}`,
                      snapshotId,
                    },
                  ).catch((err) => logger.error({ err }, "Integrity check webhook failed"));
                }
              } catch (err) {
                logger.error({ err }, "Error sending integrity check webhook");
              }

              logger.error({ agentId, snapshotId, checkMessage }, "Integrity check FAILED");
            } else {
              logger.info({ agentId, snapshotId }, "Integrity check passed");
            }
          }
          broadcastToUi({ type: "check_result", agentId, ...msg });
          return;
        }

        if (msg.type === "snapshot_done") {
          const db = getDb();
          const snapshotId = msg.snapshotId as string;
          const status = msg.status as string;

          if (snapshotId) {
            db.update(snapshots)
              .set({
                status,
                resticSnapshotId: msg.resticSnapshotId as string | undefined,
                sizeBytes: msg.sizeBytes as number | undefined,
                fileCount: msg.fileCount as number | undefined,
                durationSeconds: msg.durationSeconds as number | undefined,
                finishedAt: new Date().toISOString(),
                errorMessage: msg.errorMessage as string | undefined,
              })
              .where(eq(snapshots.id, snapshotId))
              .run();

            // Update agent status back to online
            db.update(agents)
              .set({ status: "online" })
              .where(eq(agents.id, agentId))
              .run();

            // Send email notification (fire-and-forget)
            try {
              const [notifRow] = db.select().from(notificationSettings).all();
              const shouldNotify =
                notifRow?.emailEnabled &&
                ((status === "success" && notifRow.notifyOnSuccess) ||
                  (status === "failed" && notifRow.notifyOnFailure));

              if (shouldNotify && notifRow) {
                const recipients: string[] = JSON.parse(notifRow.emailRecipients ?? "[]");
                if (recipients.length > 0) {
                  // Look up job + agent names for email body
                  const [snap] = db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).all();
                  const [job] = snap?.jobId
                    ? db.select({ name: backupJobs.name }).from(backupJobs).where(eq(backupJobs.id, snap.jobId)).all()
                    : [];
                  const [agentRow] = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).all();

                  // Decrypt SMTP password if stored
                  let smtpPass: string | undefined;
                  if (notifRow.smtpPassEncrypted) {
                    try { smtpPass = decrypt(notifRow.smtpPassEncrypted); } catch { /* ignore */ }
                  }

                  sendBackupNotification(recipients, {
                    jobName: job?.name ?? snap?.jobId ?? "unknown",
                    agentName: agentRow?.name ?? agentId,
                    status: status as "success" | "failed",
                    startedAt: snap?.startedAt ?? new Date().toISOString(),
                    finishedAt: snap?.finishedAt ?? undefined,
                    sizeBytes: msg.sizeBytes as number | undefined,
                    fileCount: msg.fileCount as number | undefined,
                    durationSeconds: msg.durationSeconds as number | undefined,
                    errorMessage: msg.errorMessage as string | undefined,
                    snapshotId,
                  }, {
                    smtpHost: notifRow.smtpHost,
                    smtpPort: notifRow.smtpPort,
                    smtpUser: notifRow.smtpUser,
                    smtpFrom: notifRow.smtpFrom,
                    smtpPass,
                  }).catch((err) => logger.error({ err }, "Email notification failed"));
                }
              }
            } catch (err) {
              logger.error({ err }, "Error preparing email notification");
            }

            // ── Webhook notification ──────────────────────────────────────
            try {
              const [notifRow] = db.select().from(notificationSettings).all();
              const shouldWebhook =
                notifRow?.webhookEnabled &&
                notifRow.webhookUrl &&
                ((status === "success" && notifRow.webhookOnSuccess) ||
                  (status === "failed" && notifRow.webhookOnFailure));

              if (shouldWebhook && notifRow?.webhookUrl) {
                const [snap] = db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).all();
                const [job] = snap?.jobId
                  ? db.select({ name: backupJobs.name }).from(backupJobs).where(eq(backupJobs.id, snap.jobId)).all()
                  : [];
                const [agentRow] = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).all();

                sendWebhookNotification(
                  notifRow.webhookUrl,
                  (notifRow.webhookType ?? "generic") as WebhookType,
                  {
                    jobName: job?.name ?? snap?.jobId ?? "unknown",
                    agentName: agentRow?.name ?? agentId,
                    status: status as "success" | "failed",
                    startedAt: snap?.startedAt ?? new Date().toISOString(),
                    finishedAt: snap?.finishedAt ?? undefined,
                    sizeBytes: msg.sizeBytes as number | undefined,
                    fileCount: msg.fileCount as number | undefined,
                    durationSeconds: msg.durationSeconds as number | undefined,
                    errorMessage: msg.errorMessage as string | undefined,
                    snapshotId,
                  },
                ).catch((err) => logger.error({ err }, "Webhook notification failed"));
              }
            } catch (err) {
              logger.error({ err }, "Error preparing webhook notification");
            }
          }
          broadcastToUi({ type: "snapshot_done", agentId, ...msg });
          return;
        }
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeatInterval);
      if (isUi) {
        uiConnections.delete(ws);
        return;
      }
      const agentId = socketToAgent.get(ws);
      if (agentId) {
        agentConnections.delete(agentId);
        socketToAgent.delete(ws);
        const db = getDb();
        db.update(agents)
          .set({ status: "offline" })
          .where(eq(agents.id, agentId))
          .run();
        broadcastToUi({ type: "agent_status", agentId, status: "offline" });
        logger.info({ agentId }, "Agent disconnected");
      }
    });

    ws.on("error", (err) => {
      logger.error({ err }, "WebSocket error");
    });
  });

  return wss;
}

export function broadcastToUi(msg: unknown): void {
  const json = JSON.stringify(msg);
  for (const ws of uiConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

export function sendToAgent(agentId: string, msg: unknown): boolean {
  const ws = agentConnections.get(agentId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

export function isAgentOnline(agentId: string): boolean {
  const ws = agentConnections.get(agentId);
  return !!ws && ws.readyState === WebSocket.OPEN;
}
