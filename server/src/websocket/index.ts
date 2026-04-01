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
import { agents, snapshots, snapshotLogs } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sha256 } from "../crypto/encryption.js";

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
