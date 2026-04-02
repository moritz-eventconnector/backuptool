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
      window.location.href = "/login";
      throw new ApiError(401, "Unauthorized");
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error || "Request failed");
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
    request<{ user: User; accessToken: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request<User>("/auth/me"),
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

  // Snapshots
  listSnapshots: (limit = 100) => request<Snapshot[]>(`/snapshots?limit=${limit}`),
  getSnapshot: (id: string) => request<Snapshot>(`/snapshots/${id}`),
  getSnapshotLogs: (id: string) => request<SnapshotLog[]>(`/snapshots/${id}/logs`),
  deleteSnapshot: (id: string) => request(`/snapshots/${id}`, { method: "DELETE" }),

  // Destinations
  listDestinations: () => request<Destination[]>("/destinations"),
  createDestination: (data: { name: string; type: string; config: Record<string, unknown> }) =>
    request<Destination>("/destinations", { method: "POST", body: JSON.stringify(data) }),
  deleteDestination: (id: string) => request(`/destinations/${id}`, { method: "DELETE" }),

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

  // Settings — Users
  listUsers: () => request<User[]>("/settings/users"),
  createUser: (data: { email: string; name: string; password: string; role: string }) =>
    request<User>("/settings/users", { method: "POST", body: JSON.stringify(data) }),
  updateUser: (id: string, data: { name?: string; role?: string; password?: string }) =>
    request(`/settings/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteUser: (id: string) => request(`/settings/users/${id}`, { method: "DELETE" }),

  // Snapshot restore
  restoreSnapshot: (id: string, restorePath: string) =>
    request(`/snapshots/${id}/restore`, { method: "POST", body: JSON.stringify({ restorePath }) }),
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
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  jobId: string;
  agentId: string;
  resticSnapshotId?: string;
  sizeBytes?: number;
  fileCount?: number;
  durationSeconds?: number;
  status: "running" | "success" | "failed" | "cancelled";
  errorMessage?: string;
  startedAt: string;
  finishedAt?: string;
  retryCount: number;
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
  createdAt: string;
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
}
