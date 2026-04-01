/**
 * Webhook notifications for backup events.
 *
 * Supported targets:
 *   slack    — Slack Incoming Webhook (Block Kit attachment)
 *   ntfy     — ntfy.sh push notification (or self-hosted ntfy)
 *   discord  — Discord Webhook (embed)
 *   generic  — Plain JSON POST to any HTTP endpoint
 */

import { logger } from "../logger.js";

export type WebhookType = "slack" | "ntfy" | "discord" | "generic";

export interface WebhookPayload {
  jobName: string;
  agentName: string;
  status: "success" | "failed" | "started";
  startedAt: string;
  finishedAt?: string;
  sizeBytes?: number;
  fileCount?: number;
  durationSeconds?: number;
  errorMessage?: string;
  snapshotId: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function summaryLine(p: WebhookPayload): string {
  const parts: string[] = [];
  if (p.durationSeconds != null) parts.push(`${p.durationSeconds.toFixed(1)}s`);
  if (p.sizeBytes != null) parts.push(fmtSize(p.sizeBytes));
  if (p.fileCount != null) parts.push(`${p.fileCount} files`);
  return parts.join(" · ");
}

const STATUS_EMOJI: Record<string, string> = {
  success: "✅",
  failed: "❌",
  started: "🔄",
};

// ── Per-target body builders ─────────────────────────────────────────────────

function buildSlackBody(p: WebhookPayload): unknown {
  const color = p.status === "success" ? "#22c55e" : p.status === "failed" ? "#ef4444" : "#6366f1";
  const title = `${STATUS_EMOJI[p.status] ?? ""} Backup ${p.status}: ${p.jobName}`;
  const text = [
    `*Agent:* ${p.agentName}`,
    `*Started:* ${new Date(p.startedAt).toLocaleString()}`,
    summaryLine(p) ? `*Stats:* ${summaryLine(p)}` : null,
    p.errorMessage ? `*Error:* ${p.errorMessage}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    attachments: [
      {
        color,
        title,
        text,
        footer: `BackupTool · ${p.snapshotId.slice(0, 8)}`,
        ts: Math.floor(new Date(p.startedAt).getTime() / 1000),
      },
    ],
  };
}

function buildDiscordBody(p: WebhookPayload): unknown {
  const color = p.status === "success" ? 0x22c55e : p.status === "failed" ? 0xef4444 : 0x6366f1;
  const fields = [
    { name: "Agent", value: p.agentName, inline: true },
    { name: "Status", value: `${STATUS_EMOJI[p.status] ?? ""} ${p.status}`, inline: true },
  ];
  if (summaryLine(p)) fields.push({ name: "Stats", value: summaryLine(p), inline: false });
  if (p.errorMessage) fields.push({ name: "Error", value: p.errorMessage, inline: false });

  return {
    embeds: [
      {
        title: `Backup ${p.status}: ${p.jobName}`,
        color,
        fields,
        footer: { text: `BackupTool · ${p.snapshotId.slice(0, 8)}` },
        timestamp: p.startedAt,
      },
    ],
  };
}

function buildNtfyHeaders(p: WebhookPayload): Record<string, string> {
  const priority = p.status === "failed" ? "high" : "default";
  const emoji = STATUS_EMOJI[p.status] ?? "";
  return {
    "Content-Type": "text/plain",
    Title: `${emoji} Backup ${p.status}: ${p.jobName}`,
    Priority: priority,
    Tags: p.status === "failed" ? "warning" : "white_check_mark",
  };
}

function buildNtfyBody(p: WebhookPayload): string {
  const lines = [`Agent: ${p.agentName}`];
  if (summaryLine(p)) lines.push(`Stats: ${summaryLine(p)}`);
  if (p.errorMessage) lines.push(`Error: ${p.errorMessage}`);
  return lines.join("\n");
}

function buildGenericBody(p: WebhookPayload): unknown {
  return {
    event: `backup_${p.status}`,
    job: p.jobName,
    agent: p.agentName,
    status: p.status,
    snapshotId: p.snapshotId,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
    sizeBytes: p.sizeBytes,
    fileCount: p.fileCount,
    durationSeconds: p.durationSeconds,
    errorMessage: p.errorMessage,
  };
}

// ── Main send function ────────────────────────────────────────────────────────

export async function sendWebhookNotification(
  url: string,
  type: WebhookType,
  payload: WebhookPayload,
): Promise<void> {
  let body: string;
  const headers: Record<string, string> = {};

  if (type === "ntfy") {
    Object.assign(headers, buildNtfyHeaders(payload));
    body = buildNtfyBody(payload);
  } else {
    headers["Content-Type"] = "application/json";
    const bodyObj =
      type === "slack"
        ? buildSlackBody(payload)
        : type === "discord"
          ? buildDiscordBody(payload)
          : buildGenericBody(payload);
    body = JSON.stringify(bodyObj);
  }

  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook ${type} returned ${res.status}: ${text.slice(0, 200)}`);
  }

  logger.debug({ type, status: payload.status, job: payload.jobName }, "Webhook sent");
}
