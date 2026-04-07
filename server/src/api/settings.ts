import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { users, notificationSettings, auditLog } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { hashPassword } from "../auth/password.js";
import { encrypt, decrypt } from "../crypto/encryption.js";
import { logger } from "../logger.js";
import { sendBackupNotification } from "../notifications/email.js";
import { sendWebhookNotification, type WebhookType } from "../notifications/webhook.js";
import { config } from "../config.js";
import { requireFeature, getCurrentLicense } from "../licensing/enforcement.js";

export const settingsRouter = Router();

// ── Notification Settings ─────────────────────────────────────────────────────

// GET /api/settings/notifications
settingsRouter.get("/notifications", requireAuth, (_req, res) => {
  const db = getDb();
  const [row] = db.select().from(notificationSettings).all();
  if (!row) {
    res.json({
      id: "singleton",
      emailEnabled: false,
      emailRecipients: [],
      notifyOnStart: false,
      notifyOnSuccess: true,
      notifyOnFailure: true,
    });
    return;
  }

  // Decrypt SMTP password before returning (omit the raw encrypted field)
  let smtpPassDecrypted: string | undefined;
  if (row.smtpPassEncrypted) {
    try { smtpPassDecrypted = decrypt(row.smtpPassEncrypted); } catch { /* ignore */ }
  }

  const { smtpPassEncrypted: _omit, ...rest } = row;
  res.json({
    ...rest,
    emailRecipients: JSON.parse(row.emailRecipients ?? "[]"),
    smtpPass: smtpPassDecrypted,
    // webhook fields are plain-text — already included via ...rest
  });
});

const notifSchema = z.object({
  // Email
  emailEnabled: z.boolean(),
  emailRecipients: z.array(z.string().email()).default([]),
  notifyOnStart: z.boolean().default(false),
  notifyOnSuccess: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(true),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().optional(),
  // Webhook
  webhookEnabled: z.boolean().default(false),
  webhookUrl: z.string().url().optional().or(z.literal("")),
  webhookType: z.enum(["slack", "ntfy", "discord", "generic"]).default("generic"),
  webhookOnStart: z.boolean().default(false),
  webhookOnSuccess: z.boolean().default(true),
  webhookOnFailure: z.boolean().default(true),
});

// PUT /api/settings/notifications
settingsRouter.put("/notifications", requireAuth, requireRole("admin"), (req, res) => {
  const parse = notifSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const data = parse.data;

  // Encrypt password if provided; otherwise preserve existing encrypted value
  let smtpPassEncrypted: string | null = null;
  if (data.smtpPass) {
    smtpPassEncrypted = encrypt(data.smtpPass);
  } else {
    // Keep existing encrypted password
    const [existing] = db.select({ smtpPassEncrypted: notificationSettings.smtpPassEncrypted }).from(notificationSettings).all();
    smtpPassEncrypted = existing?.smtpPassEncrypted ?? null;
  }

  const baseValues = {
    emailEnabled: data.emailEnabled,
    emailRecipients: JSON.stringify(data.emailRecipients),
    notifyOnStart: data.notifyOnStart,
    notifyOnSuccess: data.notifyOnSuccess,
    notifyOnFailure: data.notifyOnFailure,
    smtpHost: data.smtpHost ?? null,
    smtpPort: data.smtpPort ?? null,
    smtpUser: data.smtpUser ?? null,
    smtpPassEncrypted,
    smtpFrom: data.smtpFrom ?? null,
    webhookEnabled: data.webhookEnabled,
    webhookUrl: data.webhookUrl || null,
    webhookType: data.webhookType,
    webhookOnStart: data.webhookOnStart,
    webhookOnSuccess: data.webhookOnSuccess,
    webhookOnFailure: data.webhookOnFailure,
    updatedAt: new Date().toISOString(),
  };

  db.insert(notificationSettings).values({ id: "singleton", ...baseValues })
    .onConflictDoUpdate({ target: notificationSettings.id, set: baseValues })
    .run();

  logger.info({ adminId: req.user?.id ?? "system" }, "Notification settings updated");
  res.json({ message: "Notification settings saved" });
});

// ── GET /api/settings/sso-status — which SSO providers are configured ────────
settingsRouter.get("/sso-status", requireAuth, (_req, res) => {
  res.json({
    oidc: {
      enabled: config.oidc.enabled,
      issuerUrl: config.oidc.issuerUrl || null,
      clientId: config.oidc.clientId || null,
      redirectUri: config.oidc.redirectUri,
      name: config.oidc.name,
    },
    saml: {
      enabled: config.saml.enabled,
      entryPoint: config.saml.entryPoint || null,
      issuer: config.saml.issuer,
      callbackUrl: config.saml.callbackUrl,
    },
    ldap: {
      enabled: config.ldap.enabled,
      url: config.ldap.url || null,
      searchBase: config.ldap.searchBase || null,
      searchFilter: config.ldap.searchFilter,
    },
  });
});

// ── POST /api/settings/notifications/test — send a test notification ─────────
const testSchema = z.object({
  type: z.enum(["email", "webhook"]),
});

settingsRouter.post("/notifications/test", requireAuth, requireRole("admin", "operator"), async (req, res) => {
  const parse = testSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "type must be 'email' or 'webhook'" });
    return;
  }

  const db = getDb();
  const [row] = db.select().from(notificationSettings).all();
  if (!row) {
    res.status(400).json({ error: "Notification settings not configured yet" });
    return;
  }

  const now = new Date().toISOString();
  const payload = {
    jobName: "Test Job",
    agentName: "BackupTool Server",
    status: "success" as const,
    startedAt: now,
    finishedAt: now,
    sizeBytes: 123_456_789,
    fileCount: 42,
    durationSeconds: 7.3,
    snapshotId: "test-" + Date.now(),
  };

  if (parse.data.type === "email") {
    if (!row.emailEnabled || !row.smtpHost) {
      res.status(400).json({ error: "Email notifications are not configured" });
      return;
    }
    const recipients: string[] = JSON.parse(row.emailRecipients ?? "[]");
    if (recipients.length === 0) {
      res.status(400).json({ error: "No recipients configured" });
      return;
    }
    let smtpPass: string | undefined;
    if (row.smtpPassEncrypted) {
      try { smtpPass = decrypt(row.smtpPassEncrypted); } catch { /* ignore */ }
    }
    try {
      await sendBackupNotification(recipients, payload, {
        smtpHost: row.smtpHost, smtpPort: row.smtpPort,
        smtpUser: row.smtpUser, smtpFrom: row.smtpFrom, smtpPass,
      });
      res.json({ message: `Test email sent to ${recipients.join(", ")}` });
    } catch (err) {
      logger.error({ err }, "Test email failed");
      res.status(500).json({ error: (err as Error).message });
    }
    return;
  }

  // webhook
  if (!row.webhookEnabled || !row.webhookUrl) {
    res.status(400).json({ error: "Webhook notifications are not configured" });
    return;
  }
  try {
    await sendWebhookNotification(row.webhookUrl, (row.webhookType ?? "generic") as WebhookType, payload);
    res.json({ message: `Test ${row.webhookType ?? "generic"} webhook sent to ${row.webhookUrl}` });
  } catch (err) {
    logger.error({ err }, "Test webhook failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── User Management ───────────────────────────────────────────────────────────

// GET /api/settings/users
settingsRouter.get("/users", requireAuth, requireRole("admin"), (_req, res) => {
  const db = getDb();
  const all = db.select({
    id: users.id,
    email: users.email,
    name: users.name,
    role: users.role,
    ssoProvider: users.ssoProvider,
    totpEnabled: users.totpEnabled,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  }).from(users).all();
  res.json(all);
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(12, "Password must be at least 12 characters"),
  role: z.enum(["admin", "operator", "viewer"]).default("viewer"),
});

// POST /api/settings/users — requires pro or enterprise (community = 1 user only)
settingsRouter.post("/users", requireAuth, requireRole("admin"), requireFeature("multi_user"), async (req, res) => {
  const parse = createUserSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const [existing] = db.select({ id: users.id }).from(users).where(eq(users.email, parse.data.email)).all();
  if (existing) {
    res.status(409).json({ error: "A user with this email already exists" });
    return;
  }

  const passwordHash = await hashPassword(parse.data.password);
  const id = nanoid();

  db.insert(users).values({
    id,
    email: parse.data.email,
    name: parse.data.name,
    passwordHash,
    role: parse.data.role,
  }).run();

  db.insert(auditLog).values({
    id: nanoid(),
    userId: req.user!.id,
    action: "create_user",
    resource: `user:${id}`,
    details: JSON.stringify({ email: parse.data.email, role: parse.data.role }),
    ip: req.ip,
  }).run();

  logger.info({ adminId: req.user!.id, newUserId: id, email: parse.data.email }, "User created");
  res.status(201).json({ id, email: parse.data.email, name: parse.data.name, role: parse.data.role });
});

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(["admin", "operator", "viewer"]).optional(),
  password: z.string().min(12).optional(),
});

// PATCH /api/settings/users/:id
settingsRouter.patch("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = updateUserSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const [user] = db.select().from(users).where(eq(users.id, req.params.id)).all();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parse.data.name) updates.name = parse.data.name;
  if (parse.data.role) updates.role = parse.data.role;
  if (parse.data.password) updates.passwordHash = await hashPassword(parse.data.password);

  db.update(users)
    .set(updates as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(users.id, req.params.id))
    .run();

  logger.info({ adminId: req.user!.id, userId: req.params.id }, "User updated");
  res.json({ message: "User updated" });
});

// DELETE /api/settings/users/:id
settingsRouter.delete("/users/:id", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();

  // Prevent deleting yourself
  if (req.params.id === req.user!.id) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }

  const [user] = db.select().from(users).where(eq(users.id, req.params.id)).all();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  db.delete(users).where(eq(users.id, req.params.id)).run();

  db.insert(auditLog).values({
    id: nanoid(),
    userId: req.user!.id,
    action: "delete_user",
    resource: `user:${req.params.id}`,
    ip: req.ip,
  }).run();

  logger.info({ adminId: req.user!.id, userId: req.params.id }, "User deleted");
  res.json({ message: "User deleted" });
});

// GET /api/settings/audit-log
settingsRouter.get("/audit-log", requireAuth, requireRole("admin"), (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit as string ?? "100", 10), 500);
  const logs = db.select().from(auditLog)
    .orderBy(auditLog.createdAt)
    .limit(limit)
    .all();
  res.json(logs);
});
