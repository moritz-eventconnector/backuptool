/**
 * SSO routes: OIDC, SAML 2.0, LDAP
 * Each provider can be configured via environment variables or via the
 * SSO config table (encrypted in DB).
 */
import { Router } from "express";
import { Issuer, generators } from "openid-client";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { users, auditLog } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { signAccessToken, refreshTokenTtlMs } from "../auth/jwt.js";
import { randomToken, sha256 } from "../crypto/encryption.js";
import { refreshTokens } from "../db/schema/index.js";
import { logger } from "../logger.js";

export const ssoRouter = Router();

// In-memory OIDC state/nonce store (use Redis in HA setups)
const pendingOidcStates = new Map<string, { nonce: string; redirectTo: string }>();

// ── OIDC ──────────────────────────────────────────────────────────────────────

ssoRouter.get("/oidc/login", async (req, res) => {
  if (!config.oidc.enabled) {
    res.status(404).json({ error: "OIDC SSO is not configured" });
    return;
  }

  try {
    const issuer = await Issuer.discover(config.oidc.issuerUrl);
    const client = new issuer.Client({
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      redirect_uris: [config.oidc.redirectUri],
      response_types: ["code"],
    });

    const state = generators.state();
    const nonce = generators.nonce();
    const redirectTo = (req.query.redirect as string) || "/";

    pendingOidcStates.set(state, { nonce, redirectTo });
    // Clean up old states after 10 minutes
    setTimeout(() => pendingOidcStates.delete(state), 10 * 60 * 1000);

    const url = client.authorizationUrl({
      scope: "openid email profile",
      state,
      nonce,
    });

    res.redirect(url);
  } catch (err) {
    logger.error({ err }, "OIDC login initiation failed");
    res.status(500).json({ error: "OIDC configuration error" });
  }
});

ssoRouter.get("/oidc/callback", async (req, res) => {
  if (!config.oidc.enabled) {
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
    const issuer = await Issuer.discover(config.oidc.issuerUrl);
    const client = new issuer.Client({
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      redirect_uris: [config.oidc.redirectUri],
      response_types: ["code"],
    });

    const params = client.callbackParams(req);
    const tokenSet = await client.callback(config.oidc.redirectUri, params, {
      state,
      nonce: pending.nonce,
    });

    const claims = tokenSet.claims();
    const email = claims.email as string;
    const name = (claims.name as string) || (claims.preferred_username as string) || email;
    const ssoId = claims.sub;

    if (!email) {
      res.status(400).json({ error: "OIDC provider did not return an email address" });
      return;
    }

    const user = await findOrCreateSsoUser(email, name, "oidc", ssoId, req.ip ?? "");
    await issueSessionAndRedirect(res, user, pending.redirectTo);
  } catch (err) {
    logger.error({ err }, "OIDC callback failed");
    res.status(500).json({ error: "OIDC authentication failed" });
  }
});

// ── LDAP ──────────────────────────────────────────────────────────────────────

ssoRouter.post("/ldap/login", async (req, res) => {
  if (!config.ldap.enabled) {
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
    // Dynamic import to avoid requiring ldapjs when LDAP is disabled
    const ldap = await import("ldapjs");
    const client = ldap.createClient({ url: config.ldap.url });

    // Bind as service account
    await new Promise<void>((resolve, reject) => {
      client.bind(config.ldap.bindDn, config.ldap.bindCredentials, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Search for user
    const filter = config.ldap.searchFilter.replace("{{username}}", username);
    const searchResult = await new Promise<{ dn: string; email: string; name: string } | null>(
      (resolve, reject) => {
        client.search(
          config.ldap.searchBase,
          { scope: "sub", filter, attributes: ["dn", "mail", "cn", "displayName", "givenName"] },
          (err, res) => {
            if (err) { reject(err); return; }
            let found: { dn: string; email: string; name: string } | null = null;
            res.on("searchEntry", (entry) => {
              const attrs = entry.pojo.attributes;
              const get = (name: string) =>
                attrs.find((a) => a.type === name)?.values[0] ?? "";
              found = {
                dn: entry.pojo.objectName,
                email: get("mail"),
                name: get("displayName") || get("cn") || get("givenName") || username,
              };
            });
            res.on("error", reject);
            res.on("end", () => resolve(found));
          }
        );
      }
    );

    if (!searchResult) {
      client.destroy();
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    // Bind as the user to verify password
    await new Promise<void>((resolve, reject) => {
      client.bind(searchResult.dn, password, (err) => {
        if (err) reject(err);
        else resolve();
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
      req.ip ?? ""
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
    res.status(401).json({ error: (err as Error).message === "Invalid credentials" ? "Invalid credentials" : "LDAP authentication error" });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findOrCreateSsoUser(
  email: string,
  name: string,
  provider: string,
  ssoId: string,
  ip: string
) {
  const db = getDb();
  let [user] = db.select().from(users)
    .where(eq(users.email, email))
    .all();

  if (!user) {
    const id = nanoid();
    // First SSO user gets admin role, subsequent get viewer
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
    // Link SSO to existing local account
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
  res: Parameters<(typeof ssoRouter)["get"]>[1],
  user: typeof users.$inferSelect,
  redirectTo: string
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
