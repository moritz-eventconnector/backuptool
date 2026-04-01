import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema/index.js";
import { config } from "../config.js";
import fs from "fs";
import path from "path";
import { logger } from "../logger.js";

let db: ReturnType<typeof drizzle<typeof schema>>;

export function getDb() {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export async function initDb(): Promise<void> {
  // Ensure data directory exists
  const dbDir = path.dirname(config.dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  const sqlite = new Database(config.dbPath);

  // Enable WAL mode for better concurrent read performance
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");

  db = drizzle(sqlite, { schema });

  // Run migrations
  const migrationsFolder = path.join(__dirname, "..", "..", "drizzle");
  if (fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
    logger.info("Database migrations applied");
  } else {
    // In dev without migrations, push schema directly
    logger.warn("No migrations folder found, skipping migrations");
  }

  logger.info({ path: config.dbPath }, "Database initialized");
}
