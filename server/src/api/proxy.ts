import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { appConfig } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { encrypt, decrypt } from "../crypto/encryption.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const proxyRouter = Router();

// Directory where Caddyfile + certs are written (shared volume with Caddy container)
function caddyDir() {
  return path.join(config.dataDir, "caddy");
}

// ── Schema ────────────────────────────────────────────────────────────────────

const proxySchema = z.object({
  proxyEnabled: z.boolean(),
  proxyDomain: z.string().optional(),
  proxySslMode: z.enum(["off", "letsencrypt", "custom"]).default("off"),
  proxyLetsencryptEmail: z.string().email().optional().or(z.literal("")),
  proxyAllowedIps: z.array(z.string()).default([]),
  // Custom cert/key — PEM strings; omit to keep existing
  proxyCert: z.string().optional(),
  proxyKey: z.string().optional(),
});

// ── Caddyfile generator ────────────────────────────────────────────────────────

function buildCaddyfile(opts: {
  domain?: string;
  sslMode: "off" | "letsencrypt" | "custom";
  letsencryptEmail?: string;
  allowedIps: string[];
}): string {
  const { domain, sslMode, letsencryptEmail, allowedIps } = opts;

  const lines: string[] = [];

  // Global block — only needed for Let's Encrypt email
  if (sslMode === "letsencrypt" && letsencryptEmail) {
    lines.push("{");
    lines.push(`  email ${letsencryptEmail}`);
    lines.push("}");
    lines.push("");
  }

  // Determine site address
  let siteAddr: string;
  if (!domain) {
    siteAddr = ":80";
  } else if (sslMode === "off") {
    siteAddr = `http://${domain}`;
  } else {
    siteAddr = domain; // Caddy auto-TLS or custom cert
  }

  lines.push(`${siteAddr} {`);

  // TLS directive
  if (sslMode === "custom") {
    lines.push("  tls /data/caddy/cert.pem /data/caddy/key.pem");
  }
  // letsencrypt: Caddy handles TLS automatically for named domains — no directive needed

  // IP allowlist
  if (allowedIps.length > 0) {
    lines.push("");
    lines.push("  @denied {");
    lines.push(`    not remote_ip ${allowedIps.join(" ")}`);
    lines.push("  }");
    lines.push('  respond @denied "403 Access Denied" 403');
    lines.push("");
  }

  // Reverse proxy to the Node server
  lines.push("  reverse_proxy server:3000 {");
  lines.push("    header_up Host {host}");
  lines.push("    header_up X-Real-IP {remote_host}");
  lines.push("    header_up X-Forwarded-For {remote_host}");
  lines.push("    header_up X-Forwarded-Proto {scheme}");
  lines.push("  }");
  lines.push("}");

  return lines.join("\n") + "\n";
}

// Write Caddyfile + optional cert/key files to the shared caddy directory.
function writeCaddyConfig(opts: {
  domain?: string;
  sslMode: "off" | "letsencrypt" | "custom";
  letsencryptEmail?: string;
  allowedIps: string[];
  cert?: string;
  key?: string;
}) {
  const dir = caddyDir();
  fs.mkdirSync(dir, { recursive: true });

  const caddyfile = buildCaddyfile(opts);
  fs.writeFileSync(path.join(dir, "Caddyfile"), caddyfile, "utf8");

  if (opts.sslMode === "custom") {
    if (opts.cert) fs.writeFileSync(path.join(dir, "cert.pem"), opts.cert, "utf8");
    if (opts.key)  fs.writeFileSync(path.join(dir, "key.pem"),  opts.key,  "utf8");
  }

  logger.info({ sslMode: opts.sslMode, domain: opts.domain }, "Caddyfile written");
}

// ── GET /api/settings/proxy ───────────────────────────────────────────────────

proxyRouter.get("/proxy", requireAuth, async (_req, res) => {
  const db = getDb();
  const rows = db.select().from(appConfig).where(eq(appConfig.id, "singleton")).all();
  const row = rows[0];
  if (!row) { res.json(defaultProxyConfig()); return; }

  res.json({
    proxyEnabled: row.proxyEnabled ?? false,
    proxyDomain: row.proxyDomain ?? "",
    proxySslMode: row.proxySslMode ?? "off",
    proxyLetsencryptEmail: row.proxyLetsencryptEmail ?? "",
    proxyAllowedIps: JSON.parse((row.proxyAllowedIps as string | null) ?? "[]") as string[],
    // Never expose cert/key contents — just indicate whether they are set
    hasCert: !!row.proxyCertEncrypted,
    hasKey: !!row.proxyKeyEncrypted,
  });
});

// ── PUT /api/settings/proxy ───────────────────────────────────────────────────

proxyRouter.put("/proxy", requireAuth, requireRole("admin"), async (req, res) => {
  const parsed = proxySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const data = parsed.data;
  const db = getDb();

  // Load existing row to merge secrets
  const rows = db.select().from(appConfig).where(eq(appConfig.id, "singleton")).all();
  const existing = rows[0];

  // Encrypt new cert/key if provided; keep existing if not
  let certEncrypted = existing?.proxyCertEncrypted ?? null;
  let keyEncrypted  = existing?.proxyKeyEncrypted  ?? null;
  let certPem: string | undefined;
  let keyPem:  string | undefined;

  if (data.proxyCert) {
    certEncrypted = await encrypt(data.proxyCert);
    certPem = data.proxyCert;
  } else if (certEncrypted) {
    certPem = await decrypt(certEncrypted);
  }
  if (data.proxyKey) {
    keyEncrypted = await encrypt(data.proxyKey);
    keyPem = data.proxyKey;
  } else if (keyEncrypted) {
    keyPem = await decrypt(keyEncrypted);
  }

  // Upsert app_config
  db.update(appConfig)
    .set({
      proxyEnabled: data.proxyEnabled,
      proxyDomain: data.proxyDomain || null,
      proxySslMode: data.proxySslMode,
      proxyLetsencryptEmail: data.proxyLetsencryptEmail || null,
      proxyAllowedIps: JSON.stringify(data.proxyAllowedIps),
      proxyCertEncrypted: certEncrypted,
      proxyKeyEncrypted: keyEncrypted,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(appConfig.id, "singleton"))
    .run();

  // Write Caddyfile to shared volume (Caddy picks it up via --watch)
  if (data.proxyEnabled) {
    writeCaddyConfig({
      domain: data.proxyDomain,
      sslMode: data.proxySslMode,
      letsencryptEmail: data.proxyLetsencryptEmail,
      allowedIps: data.proxyAllowedIps,
      cert: certPem,
      key: keyPem,
    });
  } else {
    // Write a minimal HTTP-only config when proxy is disabled (no allowlist, no TLS)
    writeCaddyConfig({ sslMode: "off", allowedIps: [] });
  }

  res.json({ message: "Proxy settings saved" });
});

// ── Helper ────────────────────────────────────────────────────────────────────

function defaultProxyConfig() {
  return {
    proxyEnabled: false,
    proxyDomain: "",
    proxySslMode: "off" as const,
    proxyLetsencryptEmail: "",
    proxyAllowedIps: [] as string[],
    hasCert: false,
    hasKey: false,
  };
}
