import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── Users ─────────────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"), // null for SSO-only users
  ssoProvider: text("sso_provider"),   // "oidc" | "saml" | "ldap" | null
  ssoId: text("sso_id"),
  role: text("role").notNull().default("viewer"), // "admin" | "operator" | "viewer"
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── Agents ────────────────────────────────────────────────────────────────────
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  os: text("os").notNull(),            // "linux" | "windows" | "darwin" | "kubernetes"
  arch: text("arch").notNull(),        // "amd64" | "arm64"
  version: text("version").notNull().default("unknown"),
  hostname: text("hostname").notNull(),
  ip: text("ip"),
  status: text("status").notNull().default("offline"), // "online" | "offline" | "busy"
  lastSeen: text("last_seen"),
  registrationToken: text("registration_token"),
  apiToken: text("api_token"),         // persistent auth token for WS + internal API (SHA-256 hashed)
  certFingerprint: text("cert_fingerprint"), // mTLS client cert SHA-256 fingerprint
  tags: text("tags").default("[]"),    // JSON array of tag strings
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── Destinations (storage backends) ──────────────────────────────────────────
export const destinations = sqliteTable("destinations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // "s3" | "b2" | "local" | "sftp" | "gcs" | "azure" | "rclone"
  configEncrypted: text("config_encrypted").notNull(), // AES-256-GCM encrypted JSON config
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── Backup Jobs ───────────────────────────────────────────────────────────────
export const backupJobs = sqliteTable("backup_jobs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sourcePaths: text("source_paths").notNull().default("[]"), // JSON array of paths
  destinationIds: text("destination_ids").notNull().default("[]"), // JSON array of dest IDs
  schedule: text("schedule"), // cron expression, null = manual only
  retention: text("retention").notNull().default("{}"), // JSON: { keepLast, keepDaily, keepWeekly, keepMonthly }
  resticPasswordEncrypted: text("restic_password_encrypted"), // AES-256-GCM encrypted Restic repo password
  preScript: text("pre_script"),
  postScript: text("post_script"),
  excludePatterns: text("exclude_patterns").default("[]"), // JSON array
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  maxRetries: integer("max_retries").notNull().default(3),
  retryDelaySeconds: integer("retry_delay_seconds").notNull().default(60),
  tags: text("tags").default("[]"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── Snapshots ─────────────────────────────────────────────────────────────────
export const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => backupJobs.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  destinationId: text("destination_id"),
  resticSnapshotId: text("restic_snapshot_id"),
  sizeBytes: integer("size_bytes"),
  fileCount: integer("file_count"),
  durationSeconds: real("duration_seconds"),
  status: text("status").notNull().default("running"), // "running" | "success" | "failed" | "cancelled"
  exitCode: integer("exit_code"),
  errorMessage: text("error_message"),
  startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  finishedAt: text("finished_at"),
  retryCount: integer("retry_count").notNull().default(0),
});

// ── Snapshot Logs ─────────────────────────────────────────────────────────────
export const snapshotLogs = sqliteTable("snapshot_logs", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull().references(() => snapshots.id, { onDelete: "cascade" }),
  level: text("level").notNull().default("info"), // "info" | "warn" | "error"
  message: text("message").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── License ───────────────────────────────────────────────────────────────────
export const license = sqliteTable("license", {
  id: text("id").primaryKey().default("singleton"),
  rawJwt: text("raw_jwt").notNull(),
  edition: text("edition").notNull(), // "community" | "pro" | "enterprise"
  seats: integer("seats").notNull().default(1),
  features: text("features").notNull().default("[]"), // JSON array of feature strings
  customerId: text("customer_id"),
  customerName: text("customer_name"),
  expiresAt: text("expires_at"), // null = perpetual
  activatedAt: text("activated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── Notification Settings ─────────────────────────────────────────────────────
export const notificationSettings = sqliteTable("notification_settings", {
  id: text("id").primaryKey().default("singleton"),
  emailEnabled: integer("email_enabled", { mode: "boolean" }).notNull().default(false),
  emailRecipients: text("email_recipients").notNull().default("[]"), // JSON array
  notifyOnStart: integer("notify_on_start", { mode: "boolean" }).notNull().default(false),
  notifyOnSuccess: integer("notify_on_success", { mode: "boolean" }).notNull().default(true),
  notifyOnFailure: integer("notify_on_failure", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── Audit Log ─────────────────────────────────────────────────────────────────
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  action: text("action").notNull(),   // "login" | "create_job" | "delete_agent" | ...
  resource: text("resource"),         // e.g. "agent:abc123"
  details: text("details"),           // JSON
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── SSO Config ────────────────────────────────────────────────────────────────
export const ssoConfig = sqliteTable("sso_config", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(), // "oidc" | "saml" | "ldap"
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  configEncrypted: text("config_encrypted").notNull(), // AES-256-GCM encrypted JSON
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

// ── Refresh Tokens ────────────────────────────────────────────────────────────
export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // SHA-256 of the raw token
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  revokedAt: text("revoked_at"),
});
