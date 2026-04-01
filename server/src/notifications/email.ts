import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "../logger.js";

let transporter: nodemailer.Transporter | null = null;

export function getTransporter(): nodemailer.Transporter | null {
  if (!config.smtp.host) return null;

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    });
  }
  return transporter;
}

export interface BackupEmailPayload {
  jobName: string;
  agentName: string;
  status: "started" | "success" | "failed";
  startedAt: string;
  finishedAt?: string;
  sizeBytes?: number;
  fileCount?: number;
  durationSeconds?: number;
  errorMessage?: string;
  snapshotId?: string;
}

export async function sendBackupNotification(
  recipients: string[],
  payload: BackupEmailPayload
): Promise<void> {
  const t = getTransporter();
  if (!t || recipients.length === 0) return;

  const statusEmoji = payload.status === "success" ? "✅" : payload.status === "failed" ? "❌" : "⏳";
  const subject = `${statusEmoji} Backup ${payload.status}: ${payload.jobName}`;

  const sizeMB = payload.sizeBytes ? (payload.sizeBytes / 1024 / 1024).toFixed(2) : "—";
  const duration = payload.durationSeconds ? `${payload.durationSeconds.toFixed(1)}s` : "—";

  const html = `
    <h2>${statusEmoji} Backup ${payload.status.charAt(0).toUpperCase() + payload.status.slice(1)}</h2>
    <table cellpadding="8" style="border-collapse:collapse;width:100%;max-width:600px">
      <tr><td><strong>Job</strong></td><td>${escHtml(payload.jobName)}</td></tr>
      <tr><td><strong>Agent</strong></td><td>${escHtml(payload.agentName)}</td></tr>
      <tr><td><strong>Status</strong></td><td>${payload.status}</td></tr>
      <tr><td><strong>Started</strong></td><td>${payload.startedAt}</td></tr>
      ${payload.finishedAt ? `<tr><td><strong>Finished</strong></td><td>${payload.finishedAt}</td></tr>` : ""}
      <tr><td><strong>Duration</strong></td><td>${duration}</td></tr>
      <tr><td><strong>Size</strong></td><td>${sizeMB} MB</td></tr>
      <tr><td><strong>Files</strong></td><td>${payload.fileCount ?? "—"}</td></tr>
      ${payload.errorMessage ? `<tr><td><strong>Error</strong></td><td style="color:red">${escHtml(payload.errorMessage)}</td></tr>` : ""}
    </table>
    <p style="color:#888;font-size:12px">Sent by BackupTool</p>
  `;

  try {
    await t.sendMail({
      from: config.smtp.from,
      to: recipients.join(", "),
      subject,
      html,
    });
  } catch (err) {
    logger.error({ err }, "Failed to send backup notification email");
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
