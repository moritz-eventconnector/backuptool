/**
 * Overdue backup checker.
 *
 * Runs every 15 minutes and alerts when a scheduled backup job has not
 * produced a successful snapshot within the expected window (previous
 * scheduled time + 2-hour grace period).
 */
import { Cron } from "croner";
import { getDb } from "../db/index.js";
import { backupJobs, snapshots, notificationSettings, agents } from "../db/schema/index.js";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "../logger.js";
import { sendBackupNotification } from "../notifications/email.js";
import { sendWebhookNotification, type WebhookType } from "../notifications/webhook.js";
import { decrypt } from "../crypto/encryption.js";
import { broadcastToUi } from "../websocket/index.js";

// Track last alert time per job to avoid spam (max one alert per 24 h per job).
const lastAlertedAt = new Map<string, number>();

const GRACE_PERIOD_MS = 2 * 60 * 60 * 1000;      // 2 hours
const MIN_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000; // don't re-alert within 24 h

export function startOverdueChecker(): void {
  // Run once 2 minutes after startup (give agents time to connect), then every 15 min.
  setTimeout(() => {
    checkOverdueBackups().catch((err) => logger.error({ err }, "Overdue check error"));
    setInterval(() => {
      checkOverdueBackups().catch((err) => logger.error({ err }, "Overdue check error"));
    }, 15 * 60 * 1000);
  }, 2 * 60 * 1000);
}

export async function checkOverdueBackups(): Promise<OverdueJob[]> {
  const db = getDb();
  const overdueList: OverdueJob[] = [];

  try {
    const jobs = db.select().from(backupJobs).where(eq(backupJobs.enabled, true)).all();

    for (const job of jobs) {
      if (!job.schedule) continue;

      // Find the previous scheduled run time using croner.
      let prevRun: Date | null;
      try {
        const cron = new Cron(job.schedule, { timezone: "UTC" });
        prevRun = cron.previousRun() ?? null;
      } catch {
        logger.warn({ jobId: job.id, schedule: job.schedule }, "Could not parse cron expression for overdue check");
        continue;
      }

      if (!prevRun) continue;

      // Not overdue yet if the grace period has not elapsed.
      const overdueThresholdMs = prevRun.getTime() + GRACE_PERIOD_MS;
      if (Date.now() < overdueThresholdMs) continue;

      // Check for a successful snapshot after the previous scheduled run.
      const [lastSuccess] = db.select({ startedAt: snapshots.startedAt })
        .from(snapshots)
        .where(and(eq(snapshots.jobId, job.id), eq(snapshots.status, "success")))
        .orderBy(desc(snapshots.startedAt))
        .limit(1)
        .all();

      const lastSuccessAt = lastSuccess?.startedAt ?? null;
      const isOverdue = !lastSuccessAt || new Date(lastSuccessAt) < prevRun;
      if (!isOverdue) continue;

      overdueList.push({ jobId: job.id, jobName: job.name, agentId: job.agentId, lastSuccessAt, prevRun: prevRun.toISOString() });

      // Throttle: skip if we already sent an alert within MIN_ALERT_INTERVAL_MS.
      const lastSent = lastAlertedAt.get(job.id) ?? 0;
      if (Date.now() - lastSent < MIN_ALERT_INTERVAL_MS) continue;

      lastAlertedAt.set(job.id, Date.now());
      logger.warn({ jobId: job.id, jobName: job.name, prevRun, lastSuccessAt }, "Backup job overdue — sending alert");

      // Broadcast to all connected UI clients.
      broadcastToUi({
        type: "backup_overdue",
        jobId: job.id,
        jobName: job.name,
        agentId: job.agentId,
        prevRun: prevRun.toISOString(),
        lastSuccessAt,
      });

      // Send email + webhook notifications.
      await sendOverdueNotification(job.id, job.name, job.agentId, prevRun, lastSuccessAt);
    }
  } catch (err) {
    logger.error({ err }, "Error during overdue backup check");
  }

  return overdueList;
}

async function sendOverdueNotification(
  jobId: string,
  jobName: string,
  agentId: string,
  prevRun: Date,
  lastSuccessAt: string | null,
): Promise<void> {
  const db = getDb();
  const [notifRow] = db.select().from(notificationSettings).all();
  const [agentRow] = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).all();
  const agentName = agentRow?.name ?? agentId;
  const errorMsg = `Backup overdue: scheduled at ${prevRun.toISOString()}, last success: ${lastSuccessAt ?? "never"}`;

  // Email
  if (notifRow?.emailEnabled && notifRow.notifyOnFailure) {
    const recipients: string[] = JSON.parse(notifRow.emailRecipients ?? "[]");
    if (recipients.length > 0) {
      let smtpPass: string | undefined;
      if (notifRow.smtpPassEncrypted) {
        try { smtpPass = decrypt(notifRow.smtpPassEncrypted); } catch { /* ignore */ }
      }
      sendBackupNotification(recipients, {
        jobName,
        agentName,
        status: "failed",
        startedAt: new Date().toISOString(),
        errorMessage: errorMsg,
        snapshotId: `overdue-${jobId.slice(0, 8)}`,
      }, {
        smtpHost: notifRow.smtpHost,
        smtpPort: notifRow.smtpPort,
        smtpUser: notifRow.smtpUser,
        smtpFrom: notifRow.smtpFrom,
        smtpPass,
      }).catch((err) => logger.error({ err }, "Failed to send overdue email"));
    }
  }

  // Webhook
  if (notifRow?.webhookEnabled && notifRow.webhookUrl && notifRow.webhookOnFailure) {
    sendWebhookNotification(
      notifRow.webhookUrl,
      (notifRow.webhookType ?? "generic") as WebhookType,
      {
        jobName,
        agentName,
        status: "failed",
        startedAt: new Date().toISOString(),
        errorMessage: errorMsg,
        snapshotId: `overdue-${jobId.slice(0, 8)}`,
      },
    ).catch((err) => logger.error({ err }, "Failed to send overdue webhook"));
  }
}

export interface OverdueJob {
  jobId: string;
  jobName: string;
  agentId: string;
  prevRun: string;
  lastSuccessAt: string | null;
}
