import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import fs from "fs";
import path from "path";
import { logger } from "../logger.js";

let db: ReturnType<typeof drizzle<typeof schema>>;

export function getDb() {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

/**
 * Initialize the SQLite database and ensure all tables exist.
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to run on every startup
 * without any separate migration step.
 */
export async function initDb(): Promise<void> {
  const dbDir = path.dirname(config.dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  const sqlite = new Database(config.dbPath);

  // Performance + safety pragmas
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");

  db = drizzle(sqlite, { schema });

  // Create all tables if they don't exist yet.
  // This replaces a separate migrations step and keeps the app self-contained.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT,
      sso_provider TEXT,
      sso_id TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      os TEXT NOT NULL,
      arch TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT 'unknown',
      hostname TEXT NOT NULL,
      ip TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      last_seen TEXT,
      registration_token TEXT,
      api_token TEXT,
      cert_fingerprint TEXT,
      tags TEXT DEFAULT '[]',
      discovered_services TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS destinations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS backup_jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source_paths TEXT NOT NULL DEFAULT '[]',
      destination_ids TEXT NOT NULL DEFAULT '[]',
      schedule TEXT,
      retention TEXT NOT NULL DEFAULT '{}',
      restic_password_encrypted TEXT,
      pre_script TEXT,
      post_script TEXT,
      exclude_patterns TEXT DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      worm_enabled INTEGER NOT NULL DEFAULT 0,
      worm_retention_days INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_delay_seconds INTEGER NOT NULL DEFAULT 60,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      destination_id TEXT,
      restic_snapshot_id TEXT,
      size_bytes INTEGER,
      file_count INTEGER,
      duration_seconds REAL,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      finished_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS snapshot_logs (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS license (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      raw_jwt TEXT NOT NULL,
      edition TEXT NOT NULL,
      seats INTEGER NOT NULL DEFAULT 1,
      features TEXT NOT NULL DEFAULT '[]',
      customer_id TEXT,
      customer_name TEXT,
      expires_at TEXT,
      activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      email_enabled INTEGER NOT NULL DEFAULT 0,
      email_recipients TEXT NOT NULL DEFAULT '[]',
      notify_on_start INTEGER NOT NULL DEFAULT 0,
      notify_on_success INTEGER NOT NULL DEFAULT 1,
      notify_on_failure INTEGER NOT NULL DEFAULT 1,
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_user TEXT,
      smtp_pass_encrypted TEXT,
      smtp_from TEXT,
      webhook_enabled INTEGER NOT NULL DEFAULT 0,
      webhook_url TEXT,
      webhook_type TEXT DEFAULT 'generic',
      webhook_on_start INTEGER NOT NULL DEFAULT 0,
      webhook_on_success INTEGER NOT NULL DEFAULT 1,
      webhook_on_failure INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      resource TEXT,
      details TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS sso_config (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS app_config (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      server_name TEXT NOT NULL DEFAULT 'BackupTool',
      server_url TEXT,
      setup_completed INTEGER NOT NULL DEFAULT 0,
      releases_base_url TEXT,
      restic_bin TEXT NOT NULL DEFAULT 'restic',
      rclone_bin TEXT NOT NULL DEFAULT 'rclone',
      proxy_enabled INTEGER NOT NULL DEFAULT 0,
      proxy_domain TEXT,
      proxy_ssl_mode TEXT DEFAULT 'off',
      proxy_letsencrypt_email TEXT,
      proxy_allowed_ips TEXT DEFAULT '[]',
      proxy_cert_encrypted TEXT,
      proxy_key_encrypted TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      revoked_at TEXT
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_snapshots_job_id ON snapshots(job_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_agent_id ON snapshots(agent_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_started_at ON snapshots(started_at);
    CREATE INDEX IF NOT EXISTS idx_snapshot_logs_snapshot_id ON snapshot_logs(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_backup_jobs_agent_id ON backup_jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
  `);

  // Ensure app_config singleton row exists
  const existing = db.select({ id: schema.appConfig.id }).from(schema.appConfig).all();
  if (existing.length === 0) {
    db.insert(schema.appConfig).values({ id: "singleton" }).run();
  }

  // Add app_config columns for existing databases
  for (const [col, def] of [
    ["server_name", "TEXT NOT NULL DEFAULT 'BackupTool'"],
    ["server_url", "TEXT"],
    ["setup_completed", "INTEGER NOT NULL DEFAULT 0"],
    ["releases_base_url", "TEXT"],
    ["restic_bin", "TEXT NOT NULL DEFAULT 'restic'"],
    ["rclone_bin", "TEXT NOT NULL DEFAULT 'rclone'"],
    ["proxy_enabled", "INTEGER NOT NULL DEFAULT 0"],
    ["proxy_domain", "TEXT"],
    ["proxy_ssl_mode", "TEXT DEFAULT 'off'"],
    ["proxy_letsencrypt_email", "TEXT"],
    ["proxy_allowed_ips", "TEXT DEFAULT '[]'"],
    ["proxy_cert_encrypted", "TEXT"],
    ["proxy_key_encrypted", "TEXT"],
    ["updated_at", "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))"],
  ] as [string, string][]) {
    try { sqlite.exec(`ALTER TABLE app_config ADD COLUMN ${col} ${def};`); } catch { /* exists */ }
  }

  // Add audit_log columns for existing databases.
  try { sqlite.exec(`ALTER TABLE audit_log ADD COLUMN user_email TEXT;`); } catch { /* exists */ }

  // Add backup_jobs columns for deep verify, key rotation, and per-job repo isolation.
  for (const [col, def] of [
    ["last_verified_at", "TEXT"],
    ["last_verify_status", "TEXT"],
    ["restic_password_pending", "TEXT"],
    ["restic_repo_suffix", "TEXT"],
  ] as [string, string][]) {
    try { sqlite.exec(`ALTER TABLE backup_jobs ADD COLUMN ${col} ${def};`); } catch { /* exists */ }
  }

  // Add discovered_services column to agents for existing databases.
  try { sqlite.exec(`ALTER TABLE agents ADD COLUMN discovered_services TEXT;`); } catch { /* exists */ }

  // Add WORM columns to backup_jobs for existing databases.
  for (const [col, def] of [
    ["worm_enabled", "INTEGER NOT NULL DEFAULT 0"],
    ["worm_retention_days", "INTEGER NOT NULL DEFAULT 0"],
  ] as [string, string][]) {
    try { sqlite.exec(`ALTER TABLE backup_jobs ADD COLUMN ${col} ${def};`); } catch { /* exists */ }
  }

  // Add integrity_check_status column to snapshots for existing databases.
  try { sqlite.exec(`ALTER TABLE snapshots ADD COLUMN integrity_check_status TEXT;`); } catch { /* exists */ }

  // Add webhook columns to notification_settings for existing databases.
  // SQLite does not support "ADD COLUMN IF NOT EXISTS", so we catch the error.
  const webhookCols: [string, string][] = [
    ["webhook_enabled", "INTEGER NOT NULL DEFAULT 0"],
    ["webhook_url", "TEXT"],
    ["webhook_type", "TEXT DEFAULT 'generic'"],
    ["webhook_on_start", "INTEGER NOT NULL DEFAULT 0"],
    ["webhook_on_success", "INTEGER NOT NULL DEFAULT 1"],
    ["webhook_on_failure", "INTEGER NOT NULL DEFAULT 1"],
  ];
  for (const [col, def] of webhookCols) {
    try {
      sqlite.exec(`ALTER TABLE notification_settings ADD COLUMN ${col} ${def};`);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  logger.info({ path: config.dbPath }, "Database initialized");
}
