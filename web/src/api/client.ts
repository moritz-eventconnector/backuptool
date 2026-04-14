const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });

  if (res.status === 401) {
    // Try to refresh
    const refreshed = await fetch(`${BASE}/auth/refresh`, { method: "POST", credentials: "include" });
    if (refreshed.ok) {
      // Retry original request
      const retry = await fetch(`${BASE}${path}`, {
        credentials: "include",
        headers: { "Content-Type": "application/json", ...options?.headers },
        ...options,
      });
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({ error: retry.statusText }));
        throw new ApiError(retry.status, err.error || "Request failed");
      }
      return retry.json();
    } else {
      throw new ApiError(401, "Unauthorized");
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const message = err.error || "Request failed";
    // Show a sticky license toast for payment-required responses
    if (res.status === 402) {
      import("../context/NotificationContext.tsx").then(({ notify }) => {
        notify({ kind: "warning", title: "License restriction", message, duration: 0 });
      });
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return null as T;
  return res.json();
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ user: User; accessToken: string } | { requireTotp: true; totpToken: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  totpVerify: (totpToken: string, code: string) =>
    request<{ user: User; accessToken: string }>("/auth/totp/verify", {
      method: "POST",
      body: JSON.stringify({ totpToken, code }),
    }),
  totpSetup: () => request<{ secret: string; otpAuthUrl: string; qrDataUrl: string }>("/auth/totp/setup", { method: "POST" }),
  totpConfirm: (code: string) => request<{ message: string }>("/auth/totp/confirm", { method: "POST", body: JSON.stringify({ code }) }),
  totpDisable: (password: string) => request<{ message: string }>("/auth/totp/disable", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request<User & { totpEnabled?: boolean }>("/auth/me"),
  setupRequired: () => request<{ setupRequired: boolean }>("/auth/setup-required"),
  register: (email: string, name: string, password: string) =>
    request("/auth/register", { method: "POST", body: JSON.stringify({ email, name, password }) }),

  // Agents
  listAgents: () => request<Agent[]>("/agents"),
  getAgent: (id: string) => request<Agent>(`/agents/${id}`),
  generateAgentToken: (name: string) =>
    request<{ agentId: string; registrationToken: string }>("/agents/token", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteAgent: (id: string) => request(`/agents/${id}`, { method: "DELETE" }),
  updateAgent: (id: string) => request<{ message: string }>(`/agents/${id}/update`, { method: "POST" }),
  getDiscoveredServices: (id: string) => request<DiscoveredService[]>(`/agents/${id}/discovered`),

  // Jobs
  listJobs: () => request<Job[]>("/jobs"),
  getJob: (id: string) => request<Job>(`/jobs/${id}`),
  createJob: (data: Partial<Job>) => request<Job>("/jobs", { method: "POST", body: JSON.stringify(data) }),
  updateJob: (id: string, data: Partial<Job>) =>
    request<Job>(`/jobs/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteJob: (id: string) => request(`/jobs/${id}`, { method: "DELETE" }),
  runJob: (id: string) => request<{ snapshotId: string }>(`/jobs/${id}/run`, { method: "POST" }),
  getJobSnapshots: (id: string) => request<Snapshot[]>(`/jobs/${id}/snapshots`),
  getOverdueJobs: () => request<{ jobId: string; jobName: string; agentId: string; prevRun: string; lastSuccessAt: string | null }[]>("/jobs/overdue"),

  // Snapshots
  listSnapshots: (limit = 100) => request<Snapshot[]>(`/snapshots?limit=${limit}`),
  getSnapshot: (id: string) => request<Snapshot>(`/snapshots/${id}`),
  getSnapshotLogs: (id: string) => request<SnapshotLog[]>(`/snapshots/${id}/logs`),
  deleteSnapshot: (id: string) => request(`/snapshots/${id}`, { method: "DELETE" }),
  bulkDeleteSnapshots: (ids: string[]) => request<{ deleted: number; skipped: number; skippedIds: string[] }>(`/snapshots/bulk-delete`, { method: "POST", body: JSON.stringify({ ids }) }),
  bulkLockSnapshots: (ids: string[], days: number) => request<{ locked: number; lockedUntil: string }>(`/snapshots/bulk-lock`, { method: "POST", body: JSON.stringify({ ids, days }) }),

  // Destinations
  listDestinations: () => request<Destination[]>("/destinations"),
  getDestination: (id: string) => request<Destination & { config: Record<string, string> }>(`/destinations/${id}`),
  createDestination: (data: { name: string; type: string; config: Record<string, unknown>; wormEnabled?: boolean; wormRetentionDays?: number; wormMode?: string }) =>
    request<Destination>("/destinations", { method: "POST", body: JSON.stringify(data) }),
  updateDestination: (id: string, data: { name: string; type: string; config: Record<string, unknown>; wormEnabled?: boolean; wormRetentionDays?: number; wormMode?: string }) =>
    request(`/destinations/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  testDestination: (type: string, config: Record<string, unknown>) =>
    request<{ ok: boolean; message: string }>("/destinations/test", { method: "POST", body: JSON.stringify({ type, config }) }),
  deleteDestination: (id: string) => request(`/destinations/${id}`, { method: "DELETE" }),
  resetDestinationRepo: (id: string) => request<{ message: string; newPath: string }>(`/destinations/${id}/reset-repo`, { method: "POST" }),

  // License
  getLicense: () => request<LicenseInfo>("/license"),
  uploadLicense: (rawJwt: string) =>
    request<{ message: string }>("/license", { method: "POST", body: JSON.stringify({ license: rawJwt }) }),
  deleteLicense: () => request("/license", { method: "DELETE" }),

  // Settings — Notifications
  getNotificationSettings: () => request<NotificationSettings>("/settings/notifications"),
  saveNotificationSettings: (data: Partial<NotificationSettings>) =>
    request("/settings/notifications", { method: "PUT", body: JSON.stringify(data) }),
  testNotification: (type: "email" | "webhook") =>
    request<{ message: string }>("/settings/notifications/test", { method: "POST", body: JSON.stringify({ type }) }),
  getSsoStatus: () => request<SsoStatus>("/settings/sso-status"),

  // Settings — App Config
  getSetupStatus: () => request<{ setupCompleted: boolean }>("/settings/setup-status"),
  getAppConfig: () => request<AppConfig>("/settings/app-config"),
  saveAppConfig: (data: Partial<AppConfig>) =>
    request<{ message: string }>("/settings/app-config", { method: "PUT", body: JSON.stringify(data) }),

  // Settings — SSO Config (DB-backed)
  getSsoConfig: () => request<SsoProviderRow[]>("/settings/sso"),
  saveSsoConfig: (provider: "oidc" | "saml" | "ldap", data: { enabled: boolean; config: Record<string, unknown> }) =>
    request<{ message: string }>(`/settings/sso/${provider}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteSsoConfig: (provider: "oidc" | "saml" | "ldap") =>
    request<{ message: string }>(`/settings/sso/${provider}`, { method: "DELETE" }),

  // Settings — Proxy / SSL
  getProxyConfig: () => request<ProxyConfig>("/settings/proxy"),
  saveProxyConfig: (data: ProxyConfigInput) =>
    request<{ message: string }>("/settings/proxy", { method: "PUT", body: JSON.stringify(data) }),

  // Settings — Users
  listUsers: () => request<User[]>("/settings/users"),
  createUser: (data: { email: string; name: string; password: string; role: string }) =>
    request<User>("/settings/users", { method: "POST", body: JSON.stringify(data) }),
  updateUser: (id: string, data: { name?: string; role?: string; password?: string }) =>
    request(`/settings/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteUser: (id: string) => request(`/settings/users/${id}`, { method: "DELETE" }),

  // Snapshot restore
  restoreSnapshot: (id: string, restorePath: string, targetAgentId?: string, includePaths?: string[], destinationId?: string) =>
    request(`/snapshots/${id}/restore`, { method: "POST", body: JSON.stringify({ restorePath, targetAgentId, includePaths, destinationId }) }),
  getRestoreAgents: (id: string) => request<RestoreAgent[]>(`/snapshots/${id}/restore-agents`),
  getRestoreDestinations: (id: string) => request<RestoreDestination[]>(`/snapshots/${id}/restore-destinations`),

  // Audit log
  getAuditLogs: (params?: { action?: string; user?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.action) qs.set("action", params.action);
    if (params?.user) qs.set("user", params.user);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return request<AuditLogEntry[]>(`/audit-logs${q ? "?" + q : ""}`);
  },
  exportAuditLogs: (params?: { action?: string; user?: string; since?: string }) => {
    const qs = new URLSearchParams({ format: "csv" });
    if (params?.action) qs.set("action", params.action);
    if (params?.user) qs.set("user", params.user);
    if (params?.since) qs.set("since", params.since);
    window.location.href = `/api/audit-logs/export?${qs.toString()}`;
  },
  exportSnapshots: (params?: { jobId?: string; since?: string; status?: string }) => {
    const qs = new URLSearchParams({ format: "csv" });
    if (params?.jobId) qs.set("jobId", params.jobId);
    if (params?.since) qs.set("since", params.since);
    if (params?.status) qs.set("status", params.status);
    window.location.href = `/api/snapshots/export?${qs.toString()}`;
  },

  // Backup verification + key rotation
  verifyJob: (id: string) => request<{ message: string }>(`/jobs/${id}/verify`, { method: "POST" }),
  rotateJobKey: (id: string) => request<{ message: string }>(`/jobs/${id}/rotate-key`, { method: "POST" }),
  resetJobRepo: (id: string) => request<{ message: string; newSuffix: string }>(`/jobs/${id}/reset-repo`, { method: "POST" }),
};

// Types
export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  ssoProvider?: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  os: string;
  arch: string;
  version: string;
  hostname: string;
  ip?: string;
  status: "online" | "offline" | "busy";
  lastSeen?: string;
  tags: string[];
  createdAt: string;
}

export interface Job {
  id: string;
  agentId: string;
  name: string;
  sourcePaths: string[];
  destinationIds: string[];
  schedule?: string;
  retention: {
    keepLast?: number;
    keepDaily?: number;
    keepWeekly?: number;
    keepMonthly?: number;
  };
  preScript?: string;
  postScript?: string;
  excludePatterns: string[];
  enabled: boolean;
  maxRetries: number;
  retryDelaySeconds: number;
  wormEnabled: boolean;
  wormRetentionDays: number;
  sourceType: "local" | "s3";
  sourceConfig?: {
    endpoint?: string;
    bucket?: string;
    path?: string;
    accessKeyId?: string;
    region?: string;
    // secretAccessKey is never returned by the server
  };
  lastVerifiedAt?: string | null;
  lastVerifyStatus?: "passed" | "failed" | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  resource?: string | null;
  details?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export interface Snapshot {
  id: string;
  jobId: string;
  agentId: string;
  resticSnapshotId?: string;
  sizeBytes?: number;
  fileCount?: number;
  durationSeconds?: number;
  status: "running" | "success" | "failed" | "cancelled" | "warning" | "orphaned";
  errorMessage?: string;
  integrityCheckStatus?: "passed" | "failed" | null;
  startedAt: string;
  finishedAt?: string;
  retryCount: number;
  lockedUntil?: string | null;
}

export interface RestoreAgent {
  id: string;
  name: string;
  hostname: string;
  status: string;
  online: boolean;
  isOriginal: boolean;
}

export interface RestoreDestination {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
}

export interface SnapshotLog {
  id: string;
  snapshotId: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

export interface Destination {
  id: string;
  name: string;
  type: string;
  repoSummary?: string;
  wormEnabled: boolean;
  wormRetentionDays: number;
  wormMode: "COMPLIANCE" | "GOVERNANCE";
  createdAt: string;
  updatedAt: string;
}

export interface NotificationSettings {
  emailEnabled: boolean;
  emailRecipients: string[];
  notifyOnStart: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  webhookEnabled: boolean;
  webhookUrl?: string;
  webhookType?: "slack" | "ntfy" | "discord" | "generic";
  webhookOnStart: boolean;
  webhookOnSuccess: boolean;
  webhookOnFailure: boolean;
}

export interface SsoStatus {
  oidc: { enabled: boolean; issuerUrl: string | null; clientId: string | null; redirectUri: string; name: string };
  saml: { enabled: boolean; entryPoint: string | null; issuer: string; callbackUrl: string };
  ldap: { enabled: boolean; url: string | null; searchBase: string | null; searchFilter: string };
}

export interface DiscoveredService {
  name: string;
  type: string;
  sourcePaths: string[];
  preScript: string;
  postScript: string;
  note: string;
  priority: "critical" | "recommended" | "optional";
}

export interface AppConfig {
  serverName: string;
  serverUrl?: string;
  setupCompleted: boolean;
  releasesBaseUrl?: string;
  resticBin: string;
  rcloneBin: string;
  uiAllowlist: string[];
}

export interface ProxyConfig {
  proxyEnabled: boolean;
  proxyDomain: string;
  proxySslMode: "off" | "letsencrypt" | "custom";
  proxyLetsencryptEmail: string;
  proxyAllowedIps: string[];
  hasCert: boolean;
  hasKey: boolean;
}

export interface ProxyConfigInput {
  proxyEnabled: boolean;
  proxyDomain?: string;
  proxySslMode: "off" | "letsencrypt" | "custom";
  proxyLetsencryptEmail?: string;
  proxyAllowedIps: string[];
  proxyCert?: string;
  proxyKey?: string;
}

export interface SsoProviderRow {
  provider: "oidc" | "saml" | "ldap";
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface LicenseInfo {
  edition: "community" | "pro" | "enterprise";
  seats: number;
  features: string[];
  customerId?: string;
  customerName?: string;
  expiresAt?: string;
  activatedAt?: string;
  source: "default" | "uploaded";
  fingerprint?: string; // sha256:... of this server's machine-id
}
