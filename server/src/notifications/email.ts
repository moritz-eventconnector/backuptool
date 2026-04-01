import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "../logger.js";

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

interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Resolve SMTP settings: DB values override env-var defaults. */
function resolveSmtp(dbRow?: {
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpFrom?: string | null;
  smtpPass?: string | null; // already decrypted by caller
} | null): SmtpSettings | null {
  const host = dbRow?.smtpHost || config.smtp.host;
  if (!host) return null;
  return {
    host,
    port: dbRow?.smtpPort ?? config.smtp.port,
    secure: (dbRow?.smtpPort ?? config.smtp.port) === 465,
    user: dbRow?.smtpUser || config.smtp.user || undefined,
    pass: dbRow?.smtpPass || config.smtp.pass || undefined,
    from: dbRow?.smtpFrom || config.smtp.from,
  };
}

function buildTransporter(settings: SmtpSettings): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
  });
}

export async function sendBackupNotification(
  recipients: string[],
  payload: BackupEmailPayload,
  smtpOverride?: {
    smtpHost?: string | null;
    smtpPort?: number | null;
    smtpUser?: string | null;
    smtpFrom?: string | null;
    smtpPass?: string | null;
  } | null
): Promise<void> {
  if (recipients.length === 0) return;

  const settings = resolveSmtp(smtpOverride);
  if (!settings) return; // no SMTP configured

  const transporter = buildTransporter(settings);

  const statusEmoji = payload.status === "success" ? "✅" : payload.status === "failed" ? "❌" : "⏳";
  const subject = `${statusEmoji} Backup ${payload.status}: ${payload.jobName}`;
  const sizeMB = payload.sizeBytes ? (payload.sizeBytes / 1024 / 1024).toFixed(2) : "—";
  const duration = payload.durationSeconds ? `${payload.durationSeconds.toFixed(1)}s` : "—";

  const html = `
    <div style="font-family:sans-serif;max-width:600px">
      <h2 style="margin-bottom:16px">${statusEmoji} Backup ${payload.status.charAt(0).toUpperCase() + payload.status.slice(1)}</h2>
      <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #ddd;border-radius:4px">
        <tr style="background:#f8f8f8"><td style="border-bottom:1px solid #eee;width:140px"><strong>Job</strong></td><td style="border-bottom:1px solid #eee">${escHtml(payload.jobName)}</td></tr>
        <tr><td style="border-bottom:1px solid #eee"><strong>Agent</strong></td><td style="border-bottom:1px solid #eee">${escHtml(payload.agentName)}</td></tr>
        <tr style="background:#f8f8f8"><td style="border-bottom:1px solid #eee"><strong>Status</strong></td><td style="border-bottom:1px solid #eee">${payload.status}</td></tr>
        <tr><td style="border-bottom:1px solid #eee"><strong>Started</strong></td><td style="border-bottom:1px solid #eee">${payload.startedAt}</td></tr>
        ${payload.finishedAt ? `<tr style="background:#f8f8f8"><td style="border-bottom:1px solid #eee"><strong>Finished</strong></td><td style="border-bottom:1px solid #eee">${payload.finishedAt}</td></tr>` : ""}
        <tr><td style="border-bottom:1px solid #eee"><strong>Duration</strong></td><td style="border-bottom:1px solid #eee">${duration}</td></tr>
        <tr style="background:#f8f8f8"><td style="border-bottom:1px solid #eee"><strong>Size</strong></td><td style="border-bottom:1px solid #eee">${sizeMB} MB</td></tr>
        <tr><td style="border-bottom:1px solid #eee"><strong>Files</strong></td><td style="border-bottom:1px solid #eee">${payload.fileCount ?? "—"}</td></tr>
        ${payload.errorMessage ? `<tr style="background:#fff0f0"><td><strong>Error</strong></td><td style="color:#c00">${escHtml(payload.errorMessage)}</td></tr>` : ""}
      </table>
      <p style="color:#888;font-size:12px;margin-top:16px">Sent by BackupTool${payload.snapshotId ? ` · Snapshot: ${payload.snapshotId.slice(0, 8)}` : ""}</p>
    </div>
  `;

  try {
    await transporter.sendMail({ from: settings.from, to: recipients.join(", "), subject, html });
    logger.info({ recipients, jobName: payload.jobName, status: payload.status }, "Backup notification email sent");
  } catch (err) {
    logger.error({ err }, "Failed to send backup notification email");
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
