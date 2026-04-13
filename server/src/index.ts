import express from "express";
import http from "http";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";

import { config } from "./config.js";
import { ipAllowlistMiddleware } from "./middleware/ipAllowlist.js";
import { logger } from "./logger.js";
import { initDb } from "./db/index.js";
import { initJwtKeys } from "./auth/jwt.js";
import { initCA } from "./crypto/certs.js";
import { initWebSocket } from "./websocket/index.js";

import { authRouter } from "./api/auth.js";
import { ssoRouter } from "./api/sso.js";
import { agentsRouter } from "./api/agents.js";
import { jobsRouter } from "./api/jobs.js";
import { snapshotsRouter } from "./api/snapshots.js";
import { destinationsRouter } from "./api/destinations.js";
import { licenseRouter } from "./api/license.js";
import { internalRouter } from "./api/internal.js";
import { settingsRouter } from "./api/settings.js";
import { installRouter } from "./api/install.js";
import { appConfigRouter } from "./api/app-config.js";
import { ssoConfigRouter } from "./api/sso-config.js";
import { proxyRouter } from "./api/proxy.js";
import { auditRouter } from "./api/audit.js";
import { startOverdueChecker } from "./alerts/overdue.js";

async function main() {
  // ── Initialization ─────────────────────────────────────────────────────────
  fs.mkdirSync(config.dataDir, { recursive: true });
  await initDb();
  initJwtKeys();
  await initCA();

  // ── Express ────────────────────────────────────────────────────────────────
  const app = express();

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"], // needed for Vite HMR in dev
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          upgradeInsecureRequests: null, // Don't force HTTPS — app may run behind HTTP proxy
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  // General rate limiter
  app.use(
    "/api/",
    rateLimit({
      windowMs: 15 * 60 * 1000, // 15 min
      max: 500,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  // Stricter limiter for auth endpoints
  app.use(
    "/api/auth/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      message: { error: "Too many login attempts. Try again later." },
    })
  );

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Trust proxy (for correct IP in rate limiters, Helmet HSTS, etc.)
  app.set("trust proxy", 1);

  // ── IP Allowlist (checked before every route) ─────────────────────────────
  // Only the agent internal API (token-authenticated, not browser-based) is
  // exempt so agents can still reach the server regardless of the allowlist.
  // Everything else — including login — is blocked for non-allowed IPs.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/internal/")) { next(); return; }
    ipAllowlistMiddleware(req, res, next);
  });

  // ── API Routes ─────────────────────────────────────────────────────────────
  app.use("/api/auth", authRouter);
  app.use("/api/auth/sso", ssoRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/agents", installRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/snapshots", snapshotsRouter);
  app.use("/api/destinations", destinationsRouter);
  app.use("/api/license", licenseRouter);
  app.use("/api/internal", internalRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/settings", appConfigRouter);
  app.use("/api/settings", ssoConfigRouter);
  app.use("/api/settings", proxyRouter);
  app.use("/api/audit-logs", auditRouter);

  // Health check — available at both /health and /api/health (Docker uses /api/health)
  app.get("/health", (_req, res) => { res.json({ status: "ok", version: "1.0.0" }); });
  app.get("/api/health", (_req, res) => { res.json({ status: "ok", version: "1.0.0" }); });

  // Serve React SPA in production
  const webDistPath = path.join(process.cwd(), "..", "web", "dist");
  if (fs.existsSync(webDistPath)) {
    app.use(express.static(webDistPath));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(webDistPath, "index.html"));
    });
  }

  // ── HTTP + WebSocket server ─────────────────────────────────────────────────
  const server = http.createServer(app);
  initWebSocket(server);

  // Start background overdue backup checker
  startOverdueChecker();

  server.listen(config.port, () => {
    logger.info(`BackupTool server running on port ${config.port}`);
    logger.info(`Environment: ${config.env}`);
    if (config.oidc.enabled) logger.info(`OIDC SSO enabled (provider: ${config.oidc.name})`);
    if (config.saml.enabled) logger.info("SAML 2.0 SSO enabled");
    if (config.ldap.enabled) logger.info("LDAP authentication enabled");
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
