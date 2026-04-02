/**
 * SSO routes: OIDC, SAML 2.0, LDAP
 * Each provider can be configured via environment variables or via the
 * SSO config table (encrypted in DB).
 *
 * Migrated to openid-client v6 API.
 */
import { Router, type Response } from "express";
import {
  discovery,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  randomState,
  randomNonce,
  type Configuration,
} from "openid-client";
import { config } from "../config.js";
import { getSsoProviderConfig } from "./sso-config.js";
import { getDb } from "../db/index.js";
import { users, auditLog, refreshTokens } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { signAccessToken, refreshTokenTtlMs } from "../auth/jwt.js";
import { randomToken, sha256 } from "../crypto/encryption.js";
import { logger } from "../logger.js";

export const ssoRouter = Router();

// In-memory OIDC state/nonce store (use Redis in HA setups)
const pendingOidcStates = new Map<string, { nonce: string; redirectTo: string }>();

// Cache the OIDC configuration so we don't re-discover on every request
let cachedOidcConfig: Configuration | null = null;

/** Resolve OIDC settings: DB first, env-var fallback */
function resolveOidcSettings(): { issuerUrl: string; clientId: string; clientSecret?: string; redirectUri: string } | null {
  const db = getSsoProviderConfig("oidc");
  if (db?.issuerUrl && db?.clientId) {
    return {
      issuerUrl: db.issuerUrl as string,
      clientId: db.clientId as string,
      clientSecret: db.clientSecret as string | undefined,
      redirectUri: (db.redirectUri as string | undefined) ?? `${config.corsOrigin}/api/auth/sso/oidc/callback`,
    };
  }
  if (config.oidc.enabled && config.oidc.issuerUrl && config.oidc.clientId) {
    return config.oidc;
  }
  return null;
}

/** Resolve LDAP settings: DB first, env-var fallback */
function resolveLdapSettings(): { url: string; bindDn: string; bindCredentials: string; searchBase: string; searchFilter: string } | null {
  const db = getSsoProviderConfig("ldap");
  if (db?.url && db?.bindDn) {
    return {
      url: db.url as string,
      bindDn: db.bindDn as string,
      bindCredentials: (db.bindCredentials as string | undefined) ?? "",
      searchBase: (db.searchBase as string | undefined) ?? "dc=example,dc=com",
      searchFilter: (db.searchFilter as string | undefined) ?? "(mail={{username}})",
    };
  }
  if (config.ldap.enabled) return config.ldap;
  return null;
}

async function getOidcConfig(): Promise<Configuration> {
  if (!cachedOidcConfig) {
    const s = resolveOidcSettings();
    if (!s) throw new Error("OIDC not configured");
    cachedOidcConfig = await discovery(new URL(s.issuerUrl), s.clientId, s.clientSecret);
  }
  return cachedOidcConfig;
}

export function clearOidcConfigCache(): void {
  cachedOidcConfig = null;
}

// ── OIDC ──────────────────────────────────────────────────────────────────────

ssoRouter.get("/oidc/login", async (req, res) => {
  const oidcSettings = resolveOidcSettings();
  if (!oidcSettings) {
    res.status(404).json({ error: "OIDC SSO is not configured" });
    return;
  }

  try {
    const oidcCfg = await getOidcConfig();

    const state = randomState();
    const nonce = randomNonce();
    const redirectTo = (req.query.redirect as string) || "/";

    pendingOidcStates.set(state, { nonce, redirectTo });
    setTimeout(() => pendingOidcStates.delete(state), 10 * 60 * 1000);

    const oidcSettings2 = resolveOidcSettings()!;
    const url = buildAuthorizationUrl(oidcCfg, {
      redirect_uri: oidcSettings2.redirectUri,
      scope: "openid email profile",
      state,
      nonce,
    });

    res.redirect(url.href);
  } catch (err) {
    logger.error({ err }, "OIDC login initiation failed");
    res.status(500).json({ error: "OIDC configuration error" });
  }
});

ssoRouter.get("/oidc/callback", async (req, res) => {
  if (!resolveOidcSettings()) {
    res.status(404).json({ error: "OIDC SSO is not configured" });
    return;
  }

  const state = req.query.state as string;
  const pending = pendingOidcStates.get(state);
  if (!pending) {
    res.status(400).json({ error: "Invalid or expired OIDC state" });
    return;
  }
  pendingOidcStates.delete(state);

  try {
    const oidcCfg = await getOidcConfig();

    // Build the full callback URL from the redirect URI base + current query string
    const callbackUrl = new URL(config.oidc.redirectUri);
    callbackUrl.search = new URLSearchParams(
      req.query as Record<string, string>,
    ).toString();

    const tokens = await authorizationCodeGrant(oidcCfg, callbackUrl, {
      expectedNonce: pending.nonce,
      expectedState: state,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) {
      res.status(400).json({ error: "No ID token claims received" });
      return;
    }

    const email = claims.email as string | undefined;
    const name =
      (claims.name as string | undefined) ||
      (claims.preferred_username as string | undefined) ||
      email;
    const ssoId = claims.sub;

    if (!email) {
      res.status(400).json({ error: "OIDC provider did not return an email address" });
      return;
    }

    const user = await findOrCreateSsoUser(email, name ?? email, "oidc", ssoId, req.ip ?? "");
    await issueSessionAndRedirect(res, user, pending.redirectTo);
  } catch (err) {
    logger.error({ err }, "OIDC callback failed");
    // Invalidate cached config on discovery errors so it re-fetches next time
    cachedOidcConfig = null;
    res.status(500).json({ error: "OIDC authentication failed" });
  }
});

// ── LDAP ──────────────────────────────────────────────────────────────────────

ssoRouter.post("/ldap/login", async (req, res) => {
  const ldapSettings = resolveLdapSettings();
  if (!ldapSettings) {
    res.status(404).json({ error: "LDAP is not configured" });
    return;
  }

  const username = req.body.username as string;
  const password = req.body.password as string;

  if (!username || !password) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  try {
    const ldap = await import("ldapjs");
    const client = ldap.createClient({ url: ldapSettings.url });

    // Bind as service account
    await new Promise<void>((resolve, reject) => {
      client.bind(ldapSettings.bindDn, ldapSettings.bindCredentials, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    // Search for user
    const filter = ldapSettings.searchFilter.replace("{{username}}", username);
    const searchResult = await new Promise<{ dn: string; email: string; name: string } | null>(
      (resolve, reject) => {
        client.search(
          ldapSettings.searchBase,
          { scope: "sub", filter, attributes: ["dn", "mail", "cn", "displayName", "givenName"] },
          (err, res) => {
            if (err) { reject(err); return; }
            let found: { dn: string; email: string; name: string } | null = null;
            res.on("searchEntry", (entry) => {
              const attrs = entry.pojo.attributes;
              const get = (name: string) => attrs.find((a) => a.type === name)?.values[0] ?? "";
              found = {
                dn: entry.pojo.objectName,
                email: get("mail"),
                name: get("displayName") || get("cn") || get("givenName") || username,
              };
            });
            res.on("error", reject);
            res.on("end", () => resolve(found));
          },
        );
      },
    );

    if (!searchResult) {
      client.destroy();
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    // Bind as user to verify password
    await new Promise<void>((resolve, reject) => {
      client.bind(searchResult.dn, password, (err) => {
        if (err) reject(err); else resolve();
      });
    }).catch(() => {
      client.destroy();
      throw new Error("Invalid credentials");
    });

    client.destroy();

    const user = await findOrCreateSsoUser(
      searchResult.email || username,
      searchResult.name,
      "ldap",
      searchResult.dn,
      req.ip ?? "",
    );

    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
    const rawRefreshToken = randomToken(48);
    const db = getDb();
    db.insert(refreshTokens).values({
      id: nanoid(),
      userId: user.id,
      tokenHash: sha256(rawRefreshToken),
      expiresAt: new Date(Date.now() + refreshTokenTtlMs()).toISOString(),
    }).run();

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      accessToken,
    });
  } catch (err) {
    logger.error({ err }, "LDAP authentication failed");
    const msg = (err as Error).message;
    res.status(401).json({ error: msg === "Invalid credentials" ? msg : "LDAP authentication error" });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findOrCreateSsoUser(
  email: string,
  name: string,
  provider: string,
  ssoId: string,
  ip: string,
) {
  const db = getDb();
  let [user] = db.select().from(users).where(eq(users.email, email)).all();

  if (!user) {
    const id = nanoid();
    const existingCount = db.select().from(users).all().length;
    db.insert(users).values({
      id,
      email,
      name,
      ssoProvider: provider,
      ssoId,
      role: existingCount === 0 ? "admin" : "viewer",
    }).run();
    [user] = db.select().from(users).where(eq(users.id, id)).all();
  } else if (!user.ssoProvider) {
    db.update(users).set({ ssoProvider: provider, ssoId }).where(eq(users.id, user.id)).run();
    [user] = db.select().from(users).where(eq(users.id, user.id)).all();
  }

  db.insert(auditLog).values({
    id: nanoid(),
    userId: user.id,
    action: `login_sso_${provider}`,
    ip,
  }).run();

  return user;
}

async function issueSessionAndRedirect(
  res: Response,
  user: typeof users.$inferSelect,
  redirectTo: string,
) {
  const db = getDb();
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const rawRefreshToken = randomToken(48);
  db.insert(refreshTokens).values({
    id: nanoid(),
    userId: user.id,
    tokenHash: sha256(rawRefreshToken),
    expiresAt: new Date(Date.now() + refreshTokenTtlMs()).toISOString(),
  }).run();

  const isProduction = config.env === "production";
  res.cookie("access_token", accessToken, {
    httpOnly: true, secure: isProduction, sameSite: "lax", maxAge: 15 * 60 * 1000,
  });
  res.cookie("refresh_token", rawRefreshToken, {
    httpOnly: true, secure: isProduction, sameSite: "lax",
    path: "/api/auth/refresh", maxAge: refreshTokenTtlMs(),
  });

  const safeRedirect = redirectTo.startsWith("/") ? redirectTo : "/";
  res.redirect(`${config.corsOrigin}${safeRedirect}?login=success`);
}
