import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { users, refreshTokens, auditLog } from "../db/schema/index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signAccessToken, verifyAccessToken, refreshTokenTtlMs, getPublicKey } from "../auth/jwt.js";
import { randomToken, sha256 } from "../crypto/encryption.js";
import { requireAuth } from "../auth/middleware.js";
import { eq, and, gt } from "drizzle-orm";
import { logger } from "../logger.js";
import { config } from "../config.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(12, "Password must be at least 12 characters"),
});

function setTokenCookies(res: Parameters<typeof authRouter.get>[1], accessToken: string, refreshToken: string) {
  const isProduction = config.env === "production";
  res.cookie("access_token", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge: 15 * 60 * 1000, // 15 min
  });
  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/api/auth/refresh",
    maxAge: refreshTokenTtlMs(),
  });
}

// POST /api/auth/login
authRouter.post("/login", async (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const [user] = db.select().from(users).where(eq(users.email, parse.data.email)).all();

  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await verifyPassword(parse.data.password, user.passwordHash);
  if (!valid) {
    // Audit failed login
    db.insert(auditLog).values({
      id: nanoid(),
      userId: user.id,
      action: "login_failed",
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    }).run();
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const rawRefreshToken = randomToken(48);
  const tokenHash = sha256(rawRefreshToken);
  const expiresAt = new Date(Date.now() + refreshTokenTtlMs()).toISOString();

  db.insert(refreshTokens).values({
    id: nanoid(),
    userId: user.id,
    tokenHash,
    expiresAt,
  }).run();

  db.insert(auditLog).values({
    id: nanoid(),
    userId: user.id,
    action: "login",
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  }).run();

  setTokenCookies(res, accessToken, rawRefreshToken);

  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    accessToken,
  });
});

// POST /api/auth/logout
authRouter.post("/logout", requireAuth, (req, res) => {
  const db = getDb();
  const rawRefreshToken = req.cookies?.refresh_token as string | undefined;
  if (rawRefreshToken) {
    db.update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(refreshTokens.tokenHash, sha256(rawRefreshToken)))
      .run();
  }

  res.clearCookie("access_token");
  res.clearCookie("refresh_token", { path: "/api/auth/refresh" });

  db.insert(auditLog).values({
    id: nanoid(),
    userId: req.user!.id,
    action: "logout",
    ip: req.ip,
  }).run();

  res.json({ message: "Logged out" });
});

// POST /api/auth/refresh
authRouter.post("/refresh", (req, res) => {
  const rawRefreshToken = req.cookies?.refresh_token as string | undefined;
  if (!rawRefreshToken) {
    res.status(401).json({ error: "No refresh token" });
    return;
  }

  const db = getDb();
  const tokenHash = sha256(rawRefreshToken);
  const now = new Date().toISOString();

  const [token] = db.select().from(refreshTokens)
    .where(and(
      eq(refreshTokens.tokenHash, tokenHash),
      gt(refreshTokens.expiresAt, now),
    ))
    .all();

  if (!token || token.revokedAt) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const [user] = db.select().from(users).where(eq(users.id, token.userId)).all();
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  // Rotate refresh token
  db.update(refreshTokens)
    .set({ revokedAt: now })
    .where(eq(refreshTokens.id, token.id))
    .run();

  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const newRawToken = randomToken(48);
  const newHash = sha256(newRawToken);
  db.insert(refreshTokens).values({
    id: nanoid(),
    userId: user.id,
    tokenHash: newHash,
    expiresAt: new Date(Date.now() + refreshTokenTtlMs()).toISOString(),
  }).run();

  setTokenCookies(res, accessToken, newRawToken);
  res.json({ accessToken });
});

// GET /api/auth/me
authRouter.get("/me", requireAuth, (req, res) => {
  const db = getDb();
  const [user] = db.select({
    id: users.id,
    email: users.email,
    name: users.name,
    role: users.role,
    ssoProvider: users.ssoProvider,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.id, req.user!.id)).all();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(user);
});

// GET /api/auth/public-key — agents can fetch the JWT public key
authRouter.get("/public-key", (_req, res) => {
  res.type("text/plain").send(getPublicKey());
});

// POST /api/auth/register — first-time setup only (creates admin user)
authRouter.post("/register", async (req, res) => {
  const db = getDb();
  const existingUsers = db.select().from(users).all();
  if (existingUsers.length > 0) {
    res.status(403).json({ error: "Registration is disabled after initial setup" });
    return;
  }

  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const passwordHash = await hashPassword(parse.data.password);
  const userId = nanoid();

  db.insert(users).values({
    id: userId,
    email: parse.data.email,
    name: parse.data.name,
    passwordHash,
    role: "admin",
  }).run();

  logger.info({ email: parse.data.email }, "Initial admin user created");
  res.status(201).json({ message: "Admin user created. Please log in." });
});

// GET /api/auth/setup-required — check if first-time setup is needed
authRouter.get("/setup-required", (_req, res) => {
  const db = getDb();
  const count = db.select().from(users).all().length;
  res.json({ setupRequired: count === 0 });
});
