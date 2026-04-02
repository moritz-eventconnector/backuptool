import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { ssoConfig } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { encrypt, decrypt } from "../crypto/encryption.js";
import { logger } from "../logger.js";
import { clearOidcConfigCache } from "./sso.js";

export const ssoConfigRouter = Router();

type Provider = "oidc" | "saml" | "ldap";

// GET /api/settings/sso — list all configured providers (secrets redacted)
ssoConfigRouter.get("/sso", requireAuth, (_req, res) => {
  const db = getDb();
  const rows = db.select().from(ssoConfig).all();
  const result = rows.map((r) => {
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(decrypt(r.configEncrypted)); } catch { /* ignore */ }
    // Redact secrets from response
    const { clientSecret: _cs, bindCredentials: _bc, cert: _cert, ...safe } = cfg as Record<string, unknown>;
    return {
      provider: r.provider,
      name: r.name,
      enabled: r.enabled,
      config: safe,
    };
  });
  res.json(result);
});

const oidcSchema = z.object({
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url().optional(),
  name: z.string().default("SSO"),
});

const samlSchema = z.object({
  entryPoint: z.string().url(),
  issuer: z.string().min(1).default("backuptool"),
  cert: z.string().optional(),
  callbackUrl: z.string().url().optional(),
});

const ldapSchema = z.object({
  url: z.string().min(1),
  bindDn: z.string().min(1),
  bindCredentials: z.string().optional(),
  searchBase: z.string().min(1),
  searchFilter: z.string().default("(mail={{username}})"),
});

const putSchema = z.object({
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()),
});

// PUT /api/settings/sso/:provider
ssoConfigRouter.put("/sso/:provider", requireAuth, requireRole("admin"), (req, res) => {
  const provider = req.params.provider as Provider;
  if (!["oidc", "saml", "ldap"].includes(provider)) {
    res.status(400).json({ error: "Invalid provider. Must be oidc, saml or ldap." });
    return;
  }

  const parse = putSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  // Validate provider-specific config
  const cfgRaw = parse.data.config;
  const cfgParse =
    provider === "oidc" ? oidcSchema.safeParse(cfgRaw) :
    provider === "saml" ? samlSchema.safeParse(cfgRaw) :
    ldapSchema.safeParse(cfgRaw);

  if (!cfgParse.success) {
    res.status(400).json({ error: "Invalid provider config", details: cfgParse.error.flatten() });
    return;
  }

  const db = getDb();
  const [existing] = db.select().from(ssoConfig).where(eq(ssoConfig.provider, provider)).all();

  // Merge: keep existing secret if not provided in request
  let mergedConfig: Record<string, unknown> = { ...cfgParse.data };
  if (existing) {
    try {
      const prev = JSON.parse(decrypt(existing.configEncrypted)) as Record<string, unknown>;
      if (provider === "oidc" && !(cfgRaw as Record<string, unknown>).clientSecret && prev.clientSecret) {
        mergedConfig.clientSecret = prev.clientSecret;
      }
      if (provider === "ldap" && !(cfgRaw as Record<string, unknown>).bindCredentials && prev.bindCredentials) {
        mergedConfig.bindCredentials = prev.bindCredentials;
      }
      if (provider === "saml" && !(cfgRaw as Record<string, unknown>).cert && prev.cert) {
        mergedConfig.cert = prev.cert;
      }
    } catch { /* ignore */ }
  }

  const configEncrypted = encrypt(JSON.stringify(mergedConfig));
  const providerName = (cfgRaw as Record<string, unknown>).name as string | undefined ?? provider.toUpperCase();

  if (existing) {
    db.update(ssoConfig)
      .set({
        enabled: parse.data.enabled,
        name: providerName,
        configEncrypted,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(ssoConfig.provider, provider))
      .run();
  } else {
    db.insert(ssoConfig).values({
      id: nanoid(),
      provider,
      name: providerName,
      enabled: parse.data.enabled,
      configEncrypted,
    }).run();
  }

  if (provider === "oidc") clearOidcConfigCache();
  logger.info({ provider }, "SSO config updated");
  res.json({ message: "SSO config saved" });
});

// DELETE /api/settings/sso/:provider
ssoConfigRouter.delete("/sso/:provider", requireAuth, requireRole("admin"), (req, res) => {
  const provider = req.params.provider as Provider;
  const db = getDb();
  db.delete(ssoConfig).where(eq(ssoConfig.provider, provider)).run();
  logger.info({ provider }, "SSO config deleted");
  res.json({ message: "SSO config deleted" });
});

// Helper used by sso.ts to read a provider config from DB
export function getSsoProviderConfig(provider: Provider): Record<string, unknown> | null {
  const db = getDb();
  const [row] = db.select().from(ssoConfig).where(eq(ssoConfig.provider, provider)).all();
  if (!row?.enabled) return null;
  try { return JSON.parse(decrypt(row.configEncrypted)); } catch { return null; }
}
