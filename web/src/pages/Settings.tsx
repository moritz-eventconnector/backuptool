import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, Shield, Users, Plus, Trash2, Webhook, CheckCircle, XCircle, Globe, Lock } from "lucide-react";
import { api, type User } from "../api/client";

export default function Settings() {
  const [activeTab, setActiveTab] = useState("general");

  return (
    <div>
      <div className="page-header"><h1>Settings</h1></div>
      <div style={{ display: "flex", gap: 20 }}>
        <div style={{ width: 180, flexShrink: 0 }}>
          <nav className="sidebar-nav" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {[
              { id: "general", label: "General", icon: Globe },
              { id: "proxy", label: "Proxy / SSL", icon: Lock },
              { id: "notifications", label: "Email", icon: Mail },
              { id: "webhooks", label: "Webhooks", icon: Webhook },
              { id: "sso", label: "SSO / Auth", icon: Shield },
              { id: "users", label: "Users", icon: Users },
            ].map((t) => (
              <button key={t.id}
                onClick={() => setActiveTab(t.id)}
                className="btn-ghost"
                style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8, background: activeTab === t.id ? "rgba(99,102,241,.15)" : "transparent", color: activeTab === t.id ? "var(--primary)" : "var(--text-muted)" }}>
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div style={{ flex: 1 }}>
          {activeTab === "general" && <GeneralSettings />}
          {activeTab === "proxy" && <ProxySettings />}
          {activeTab === "notifications" && <NotificationSettings />}
          {activeTab === "webhooks" && <WebhookSettings />}
          {activeTab === "sso" && <SsoSettings />}
          {activeTab === "users" && <UserSettings />}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["app-config"], queryFn: api.getAppConfig });

  const [serverName, setServerName] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [resticBin, setResticBin] = useState<string | null>(null);
  const [rcloneBin, setRcloneBin] = useState<string | null>(null);

  if (data && serverName === null) {
    setServerName(data.serverName ?? "BackupTool");
    setServerUrl(data.serverUrl ?? "");
    setResticBin(data.resticBin ?? "restic");
    setRcloneBin(data.rcloneBin ?? "rclone");
  }

  const save = useMutation({
    mutationFn: () => api.saveAppConfig({
      serverName: serverName ?? "BackupTool",
      serverUrl: serverUrl || undefined,
      resticBin: resticBin ?? "restic",
      rcloneBin: rcloneBin ?? "rclone",
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app-config"] }),
  });

  if (isLoading) return <div className="card"><p style={{ color: "var(--text-muted)" }}>Loading…</p></div>;

  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>General Settings</h2>
      {save.isSuccess && <div className="alert alert-success" style={{ marginBottom: 12 }}>Settings saved.</div>}
      {save.isError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{(save.error as Error).message}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="form-group">
          <label>Server Name</label>
          <input value={serverName ?? ""} onChange={(e) => setServerName(e.target.value)} placeholder="BackupTool" />
          <small style={{ color: "var(--text-muted)", fontSize: 11 }}>Display name shown in the UI and notifications</small>
        </div>
        <div className="form-group">
          <label>Server URL <span style={{ color: "var(--text-muted)", fontSize: 12 }}>(optional)</span></label>
          <input value={serverUrl ?? ""} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://backup.example.com" />
          <small style={{ color: "var(--text-muted)", fontSize: 11 }}>Public URL used for SSO callbacks and install scripts</small>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="form-group">
            <label>Restic binary path</label>
            <input value={resticBin ?? ""} onChange={(e) => setResticBin(e.target.value)} placeholder="restic" />
          </div>
          <div className="form-group">
            <label>Rclone binary path</label>
            <input value={rcloneBin ?? ""} onChange={(e) => setRcloneBin(e.target.value)} placeholder="rclone" />
          </div>
        </div>
      </div>

      <div className="alert alert-info" style={{ marginTop: 16, fontSize: 12 }}>
        Only <code>MASTER_SECRET</code>, <code>DATA_DIR</code>, and <code>PORT</code> must be set as environment variables. All other configuration is stored in the database.
      </div>

      <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending} style={{ marginTop: 16 }}>
        {save.isPending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function ProxySettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["proxy-config"], queryFn: api.getProxyConfig });

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [domain, setDomain] = useState("");
  const [sslMode, setSslMode] = useState<"off" | "letsencrypt" | "custom">("off");
  const [letsencryptEmail, setLetsencryptEmail] = useState("");
  const [allowedIps, setAllowedIps] = useState("");
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");

  if (data && enabled === null) {
    setEnabled(data.proxyEnabled);
    setDomain(data.proxyDomain ?? "");
    setSslMode(data.proxySslMode ?? "off");
    setLetsencryptEmail(data.proxyLetsencryptEmail ?? "");
    setAllowedIps((data.proxyAllowedIps ?? []).join("\n"));
  }

  const save = useMutation({
    mutationFn: () => api.saveProxyConfig({
      proxyEnabled: enabled ?? false,
      proxyDomain: domain || undefined,
      proxySslMode: sslMode,
      proxyLetsencryptEmail: letsencryptEmail || undefined,
      proxyAllowedIps: allowedIps.split("\n").map((s) => s.trim()).filter(Boolean),
      proxyCert: cert || undefined,
      proxyKey: key || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxy-config"] });
      setCert("");
      setKey("");
    },
  });

  if (isLoading) return <div className="card"><p style={{ color: "var(--text-muted)" }}>Loading…</p></div>;

  const eff = enabled ?? false;

  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Proxy / SSL</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
        Caddy reverse proxy with automatic HTTPS. Start the proxy with{" "}
        <code>docker compose --profile proxy up -d</code>.
      </p>

      {save.isSuccess && <div className="alert alert-success" style={{ marginBottom: 12 }}>Settings saved. Caddy picks up the new config automatically.</div>}
      {save.isError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{(save.error as Error).message}</div>}

      <div className="form-group" style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "var(--text)" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={eff} onChange={(e) => setEnabled(e.target.checked)} />
          Enable Caddy reverse proxy
        </label>
      </div>

      {eff && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Domain */}
          <div className="form-group">
            <label>Domain</label>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="backup.example.com" />
            <small style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Hostname Caddy listens on. Must point to this server's IP via DNS.
            </small>
          </div>

          {/* SSL Mode */}
          <div className="form-group">
            <label>SSL / TLS mode</label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              {([
                { value: "off" as const, label: "HTTP only" },
                { value: "letsencrypt" as const, label: "Let's Encrypt (auto)" },
                { value: "custom" as const, label: "Custom certificate" },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSslMode(opt.value)}
                  className={sslMode === opt.value ? "btn-primary" : "btn-ghost"}
                  style={{ border: sslMode === opt.value ? undefined : "1px solid var(--border)", fontSize: 12 }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {sslMode === "letsencrypt" && (
            <div className="form-group">
              <label>ACME / Let's Encrypt email</label>
              <input
                type="email"
                value={letsencryptEmail}
                onChange={(e) => setLetsencryptEmail(e.target.value)}
                placeholder="admin@example.com"
              />
              <small style={{ color: "var(--text-muted)", fontSize: 11 }}>
                Used for expiry notifications and account recovery. Required by Let's Encrypt.
              </small>
            </div>
          )}

          {sslMode === "custom" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="form-group">
                <label>
                  Certificate (PEM)
                  {data?.hasCert && <span style={{ color: "var(--success)", fontSize: 11, marginLeft: 6 }}>✓ cert stored</span>}
                </label>
                <textarea
                  rows={6}
                  value={cert}
                  onChange={(e) => setCert(e.target.value)}
                  placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                  style={{ fontFamily: "monospace", fontSize: 11, resize: "vertical" }}
                />
                {data?.hasCert && <small style={{ color: "var(--text-muted)", fontSize: 11 }}>Leave blank to keep the existing certificate.</small>}
              </div>
              <div className="form-group">
                <label>
                  Private Key (PEM)
                  {data?.hasKey && <span style={{ color: "var(--success)", fontSize: 11, marginLeft: 6 }}>✓ key stored</span>}
                </label>
                <textarea
                  rows={6}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                  style={{ fontFamily: "monospace", fontSize: 11, resize: "vertical" }}
                />
                {data?.hasKey && <small style={{ color: "var(--text-muted)", fontSize: 11 }}>Leave blank to keep the existing key.</small>}
              </div>
            </div>
          )}

          {/* IP Allowlist */}
          <div className="form-group">
            <label>IP Allowlist <span style={{ color: "var(--text-muted)", fontSize: 12 }}>(optional)</span></label>
            <textarea
              rows={4}
              value={allowedIps}
              onChange={(e) => setAllowedIps(e.target.value)}
              placeholder={"192.168.1.0/24\n10.0.0.0/8\n203.0.113.42"}
              style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
            />
            <small style={{ color: "var(--text-muted)", fontSize: 11 }}>
              One CIDR or IP per line. Leave empty to allow all IPs. Requests outside this list receive a 403 response.
            </small>
          </div>

          <div className="alert alert-info" style={{ fontSize: 12 }}>
            <strong>How it works:</strong> Caddy runs as a separate Docker container (
            <code>--profile proxy</code>). When you save these settings, the server writes a new{" "}
            <code>Caddyfile</code> to the shared data volume. Caddy detects the change and reloads
            automatically — no restart required.
          </div>
        </div>
      )}

      <button
        className="btn-primary"
        onClick={() => save.mutate()}
        disabled={save.isPending}
        style={{ marginTop: 20 }}
      >
        {save.isPending ? "Saving…" : "Save & apply"}
      </button>
    </div>
  );
}

function NotificationSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["notif-settings"], queryFn: api.getNotificationSettings });

  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null);
  const [recipients, setRecipients] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [onStart, setOnStart] = useState(false);
  const [onSuccess, setOnSuccess] = useState(true);
  const [onFailure, setOnFailure] = useState(true);
  const [testResult, setTestResult] = useState("");

  const testMut = useMutation({
    mutationFn: () => api.testNotification("email"),
    onSuccess: (d) => setTestResult(d.message),
    onError: (e: Error) => setTestResult("Error: " + e.message),
  });

  const effective = emailEnabled ?? data?.emailEnabled ?? false;

  // Populate form from loaded data (only once)
  if (data && emailEnabled === null) {
    setEmailEnabled(data.emailEnabled);
    setRecipients((data.emailRecipients ?? []).join(", "));
    setSmtpHost(data.smtpHost ?? "");
    setSmtpPort(String(data.smtpPort ?? 587));
    setSmtpUser(data.smtpUser ?? "");
    setSmtpFrom(data.smtpFrom ?? "");
    setOnStart(data.notifyOnStart ?? false);
    setOnSuccess(data.notifyOnSuccess ?? true);
    setOnFailure(data.notifyOnFailure ?? true);
  }

  const save = useMutation({
    mutationFn: () => api.saveNotificationSettings({
      emailEnabled: effective,
      emailRecipients: recipients.split(",").map((s) => s.trim()).filter(Boolean),
      notifyOnStart: onStart,
      notifyOnSuccess: onSuccess,
      notifyOnFailure: onFailure,
      smtpHost,
      smtpPort: parseInt(smtpPort, 10) || 587,
      smtpUser,
      smtpPass: smtpPass || undefined,
      smtpFrom,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notif-settings"] }),
  });

  if (isLoading) return <div className="card"><p style={{ color: "var(--text-muted)" }}>Loading…</p></div>;

  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Email Notifications</h2>
      {save.isSuccess && <div className="alert alert-success" style={{ marginBottom: 12 }}>Settings saved.</div>}
      {save.isError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{(save.error as Error).message}</div>}
      {testResult && <div className={`alert ${testResult.startsWith("Error") ? "alert-error" : "alert-success"}`} style={{ marginBottom: 12 }}>{testResult}</div>}
      <div className="form-group">
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", cursor: "pointer" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={effective} onChange={(e) => setEmailEnabled(e.target.checked)} />
          Enable Email Notifications
        </label>
      </div>
      {effective && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group"><label>SMTP Host</label><input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" /></div>
            <div className="form-group"><label>SMTP Port</label><input type="number" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} /></div>
            <div className="form-group"><label>Username</label><input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="user@example.com" /></div>
            <div className="form-group"><label>Password</label><input type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="leave blank to keep existing" /></div>
          </div>
          <div className="form-group"><label>From Address</label><input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="backups@example.com" /></div>
          <div className="form-group"><label>Recipients (comma-separated)</label><input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="admin@example.com, team@example.com" /></div>
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            {[
              { label: "On Start", checked: onStart, set: setOnStart },
              { label: "On Success", checked: onSuccess, set: setOnSuccess },
              { label: "On Failure", checked: onFailure, set: setOnFailure },
            ].map((e) => (
              <label key={e.label} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "var(--text)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={e.checked} onChange={(ev) => e.set(ev.target.checked)} /> {e.label}
              </label>
            ))}
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {effective && (
          <button className="btn-ghost" onClick={() => { setTestResult(""); testMut.mutate(); }} disabled={testMut.isPending}
            style={{ border: "1px solid var(--border)" }}>
            {testMut.isPending ? "Sending…" : "Send Test Email"}
          </button>
        )}
      </div>
    </div>
  );
}

function WebhookSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["notif-settings"], queryFn: api.getNotificationSettings });

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [url, setUrl] = useState("");
  const [type, setType] = useState<"slack" | "ntfy" | "discord" | "generic">("generic");
  const [onStart, setOnStart] = useState(false);
  const [onSuccess, setOnSuccess] = useState(true);
  const [onFailure, setOnFailure] = useState(true);
  const [testResult, setTestResult] = useState("");
  const testMut = useMutation({
    mutationFn: () => api.testNotification("webhook"),
    onSuccess: (d) => setTestResult(d.message),
    onError: (e: Error) => setTestResult("Error: " + e.message),
  });

  const eff = enabled ?? data?.webhookEnabled ?? false;

  if (data && enabled === null) {
    setEnabled(data.webhookEnabled ?? false);
    setUrl(data.webhookUrl ?? "");
    setType((data.webhookType ?? "generic") as typeof type);
    setOnStart(data.webhookOnStart ?? false);
    setOnSuccess(data.webhookOnSuccess ?? true);
    setOnFailure(data.webhookOnFailure ?? true);
  }

  const save = useMutation({
    mutationFn: () => api.saveNotificationSettings({
      // carry over existing email fields from loaded data
      emailEnabled: data?.emailEnabled ?? false,
      emailRecipients: data?.emailRecipients ?? [],
      notifyOnStart: data?.notifyOnStart ?? false,
      notifyOnSuccess: data?.notifyOnSuccess ?? true,
      notifyOnFailure: data?.notifyOnFailure ?? true,
      smtpHost: data?.smtpHost,
      smtpPort: data?.smtpPort,
      smtpUser: data?.smtpUser,
      smtpFrom: data?.smtpFrom,
      webhookEnabled: eff,
      webhookUrl: url,
      webhookType: type,
      webhookOnStart: onStart,
      webhookOnSuccess: onSuccess,
      webhookOnFailure: onFailure,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notif-settings"] }),
  });

  const TYPE_HINTS: Record<string, string> = {
    slack: "Slack Incoming Webhook — e.g. https://hooks.slack.com/services/T…/B…/…",
    ntfy: "ntfy topic URL — e.g. https://ntfy.sh/my-topic",
    discord: "Discord Webhook — e.g. https://discord.com/api/webhooks/…",
    generic: "Any HTTP endpoint — receives a JSON body with event details",
  };

  if (isLoading) return <div className="card"><p style={{ color: "var(--text-muted)" }}>Loading…</p></div>;

  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Webhook Notifications</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
        Send notifications to Slack, ntfy, Discord or any HTTP endpoint when a backup finishes.
      </p>

      {save.isSuccess && <div className="alert alert-success" style={{ marginBottom: 12 }}>Webhook settings saved.</div>}
      {save.isError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{(save.error as Error).message}</div>}
      {testResult && <div className={`alert ${testResult.startsWith("Error") ? "alert-error" : "alert-success"}`} style={{ marginBottom: 12 }}>{testResult}</div>}

      <div className="form-group">
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", cursor: "pointer" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={eff} onChange={(e) => setEnabled(e.target.checked)} />
          Enable Webhook Notifications
        </label>
      </div>

      {eff && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 12, marginBottom: 12 }}>
            <div className="form-group">
              <label>Provider</label>
              <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="generic">Generic HTTP</option>
                <option value="slack">Slack</option>
                <option value="ntfy">ntfy</option>
                <option value="discord">Discord</option>
              </select>
            </div>
            <div className="form-group">
              <label>Webhook URL</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={TYPE_HINTS[type]} />
              <small style={{ color: "var(--text-muted)", fontSize: 11 }}>{TYPE_HINTS[type]}</small>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Send notification when:</div>
            <div style={{ display: "flex", gap: 16 }}>
              {[
                { label: "Job started", checked: onStart, set: setOnStart },
                { label: "Job succeeded", checked: onSuccess, set: setOnSuccess },
                { label: "Job failed", checked: onFailure, set: setOnFailure },
              ].map((item) => (
                <label key={item.label} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "var(--text)", fontSize: 13 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={item.checked} onChange={(e) => item.set(e.target.checked)} />
                  {item.label}
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {eff && url && (
          <button className="btn-ghost" onClick={() => { setTestResult(""); testMut.mutate(); }} disabled={testMut.isPending}
            style={{ border: "1px solid var(--border)" }}>
            {testMut.isPending ? "Sending…" : "Send Test"}
          </button>
        )}
      </div>
    </div>
  );
}

function SsoSettings() {
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["sso-config"], queryFn: api.getSsoConfig });
  const [expanded, setExpanded] = useState<"oidc" | "saml" | "ldap" | null>(null);

  const getRow = (p: "oidc" | "saml" | "ldap") => rows.find((r) => r.provider === p);

  const deleteMut = useMutation({
    mutationFn: (p: "oidc" | "saml" | "ldap") => api.deleteSsoConfig(p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sso-config"] }); setExpanded(null); },
  });

  const PROVIDERS: { key: "oidc" | "saml" | "ldap"; label: string; hint: string }[] = [
    { key: "oidc", label: "OIDC (OpenID Connect)", hint: "Google, Azure AD, Okta, Keycloak" },
    { key: "saml", label: "SAML 2.0", hint: "ADFS, enterprise IdPs" },
    { key: "ldap", label: "LDAP / Active Directory", hint: "On-premise directory" },
  ];

  if (isLoading) return <div className="card"><p style={{ color: "var(--text-muted)" }}>Loading…</p></div>;

  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Single Sign-On</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
        Configure identity providers. Credentials are encrypted in the database.
        Login endpoints: <code>/api/auth/sso/oidc/login</code> · <code>/api/auth/sso/ldap/login</code>
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {PROVIDERS.map((p) => {
          const row = getRow(p.key);
          const isOpen = expanded === p.key;
          return (
            <div key={p.key} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px" }}>
                {row?.enabled
                  ? <CheckCircle size={14} color="var(--success)" />
                  : <XCircle size={14} color="var(--text-muted)" />}
                <span style={{ fontWeight: 500, fontSize: 13 }}>{p.label}</span>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>— {p.hint}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  <span className={`badge ${row?.enabled ? "badge-success" : "badge-muted"}`} style={{ fontSize: 11 }}>
                    {row?.enabled ? "Enabled" : "Not configured"}
                  </span>
                  <button className="btn-ghost" style={{ padding: "3px 8px", fontSize: 12, border: "1px solid var(--border)" }}
                    onClick={() => setExpanded(isOpen ? null : p.key)}>
                    {isOpen ? "Close" : row ? "Edit" : "Configure"}
                  </button>
                  {row && !isOpen && (
                    <button className="btn-ghost" style={{ padding: "3px 8px", fontSize: 12, color: "var(--error)" }}
                      onClick={() => { if (confirm(`Remove ${p.label} configuration?`)) deleteMut.mutate(p.key); }}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
              {isOpen && (
                <div style={{ borderTop: "1px solid var(--border)", padding: "14px 14px" }}>
                  {p.key === "oidc" && <OidcForm existing={row?.config} onSaved={() => { qc.invalidateQueries({ queryKey: ["sso-config"] }); setExpanded(null); }} />}
                  {p.key === "saml" && <SamlForm existing={row?.config} onSaved={() => { qc.invalidateQueries({ queryKey: ["sso-config"] }); setExpanded(null); }} />}
                  {p.key === "ldap" && <LdapForm existing={row?.config} onSaved={() => { qc.invalidateQueries({ queryKey: ["sso-config"] }); setExpanded(null); }} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OidcForm({ existing, onSaved }: { existing?: Record<string, unknown>; onSaved: () => void }) {
  const [issuerUrl, setIssuerUrl] = useState((existing?.issuerUrl as string) ?? "");
  const [clientId, setClientId] = useState((existing?.clientId as string) ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState((existing?.redirectUri as string) ?? "");
  const [enabled, setEnabled] = useState(true);
  const save = useMutation({
    mutationFn: () => api.saveSsoConfig("oidc", {
      enabled,
      config: { issuerUrl, clientId, clientSecret: clientSecret || undefined, redirectUri: redirectUri || undefined },
    }),
    onSuccess: onSaved,
  });
  return (
    <div>
      {save.isError && <div className="alert alert-error" style={{ marginBottom: 10 }}>{(save.error as Error).message}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="form-group"><label>Issuer URL</label><input value={issuerUrl} onChange={(e) => setIssuerUrl(e.target.value)} placeholder="https://accounts.google.com" /></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div className="form-group"><label>Client ID</label><input value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
          <div className="form-group"><label>Client Secret {existing && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>(leave blank to keep existing)</span>}</label><input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="••••••••" /></div>
        </div>
        <div className="form-group"><label>Redirect URI <span style={{ color: "var(--text-muted)", fontSize: 11 }}>(optional)</span></label><input value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} placeholder="/api/auth/sso/oidc/callback" /></div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

function SamlForm({ existing, onSaved }: { existing?: Record<string, unknown>; onSaved: () => void }) {
  const [entryPoint, setEntryPoint] = useState((existing?.entryPoint as string) ?? "");
  const [issuer, setIssuer] = useState((existing?.issuer as string) ?? "backuptool");
  const [cert, setCert] = useState("");
  const [callbackUrl, setCallbackUrl] = useState((existing?.callbackUrl as string) ?? "");
  const [enabled, setEnabled] = useState(true);
  const save = useMutation({
    mutationFn: () => api.saveSsoConfig("saml", {
      enabled,
      config: { entryPoint, issuer, cert: cert || undefined, callbackUrl: callbackUrl || undefined },
    }),
    onSuccess: onSaved,
  });
  return (
    <div>
      {save.isError && <div className="alert alert-error" style={{ marginBottom: 10 }}>{(save.error as Error).message}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="form-group"><label>Entry Point URL</label><input value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)} placeholder="https://idp.example.com/sso/saml" /></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div className="form-group"><label>Issuer</label><input value={issuer} onChange={(e) => setIssuer(e.target.value)} /></div>
          <div className="form-group"><label>Callback URL <span style={{ color: "var(--text-muted)", fontSize: 11 }}>(optional)</span></label><input value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} /></div>
        </div>
        <div className="form-group"><label>IdP Certificate (PEM) {existing && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>(leave blank to keep existing)</span>}</label><textarea rows={4} value={cert} onChange={(e) => setCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----" style={{ fontFamily: "monospace", fontSize: 11, resize: "vertical" }} /></div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

function LdapForm({ existing, onSaved }: { existing?: Record<string, unknown>; onSaved: () => void }) {
  const [url, setUrl] = useState((existing?.url as string) ?? "");
  const [bindDn, setBindDn] = useState((existing?.bindDn as string) ?? "");
  const [bindCredentials, setBindCredentials] = useState("");
  const [searchBase, setSearchBase] = useState((existing?.searchBase as string) ?? "dc=example,dc=com");
  const [searchFilter, setSearchFilter] = useState((existing?.searchFilter as string) ?? "(mail={{username}})");
  const [enabled, setEnabled] = useState(true);
  const save = useMutation({
    mutationFn: () => api.saveSsoConfig("ldap", {
      enabled,
      config: { url, bindDn, bindCredentials: bindCredentials || undefined, searchBase, searchFilter },
    }),
    onSuccess: onSaved,
  });
  return (
    <div>
      {save.isError && <div className="alert alert-error" style={{ marginBottom: 10 }}>{(save.error as Error).message}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="form-group"><label>LDAP URL</label><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ldap://ldap.example.com:389" /></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div className="form-group"><label>Bind DN</label><input value={bindDn} onChange={(e) => setBindDn(e.target.value)} placeholder="cn=admin,dc=example,dc=com" /></div>
          <div className="form-group"><label>Bind Password {existing && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>(leave blank to keep)</span>}</label><input type="password" value={bindCredentials} onChange={(e) => setBindCredentials(e.target.value)} placeholder="••••••••" /></div>
        </div>
        <div className="form-group"><label>Search Base</label><input value={searchBase} onChange={(e) => setSearchBase(e.target.value)} /></div>
        <div className="form-group"><label>Search Filter</label><input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} /><small style={{ color: "var(--text-muted)", fontSize: 11 }}>Use {"{{username}}"} as placeholder</small></div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

function UserSettings() {
  const qc = useQueryClient();
  const { data: userList = [], isLoading } = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const [showAdd, setShowAdd] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState("");

  const createUser = useMutation({
    mutationFn: () => api.createUser({ email, name, password, role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setShowAdd(false);
      setEmail(""); setName(""); setPassword(""); setRole("viewer"); setError("");
    },
    onError: (e: Error) => setError(e.message),
  });

  const deleteUser = useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>User Management</h2>
        <button className="btn-primary" style={{ display: "flex", alignItems: "center", gap: 6 }} onClick={() => setShowAdd(true)}>
          <Plus size={14} /> Add User
        </button>
      </div>

      {showAdd && (
        <div className="card" style={{ background: "var(--bg-secondary)", marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>New User</h3>
          {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="form-group"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" /></div>
            <div className="form-group"><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" /></div>
            <div className="form-group"><label>Password (min 12 chars)</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <div className="form-group">
              <label>Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="viewer">Viewer — read-only</option>
                <option value="operator">Operator — create/run jobs</option>
                <option value="admin">Admin — full access</option>
              </select>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" onClick={() => createUser.mutate()} disabled={createUser.isPending}>
              {createUser.isPending ? "Creating…" : "Create User"}
            </button>
            <button className="btn-ghost" onClick={() => { setShowAdd(false); setError(""); }}>Cancel</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : (
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>SSO</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {(userList as User[]).map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td><span className={`badge ${u.role === "admin" ? "badge-error" : u.role === "operator" ? "badge-warning" : "badge-secondary"}`}>{u.role}</span></td>
                <td>{u.ssoProvider ? <span className="badge badge-success">{u.ssoProvider}</span> : <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>
                  <button className="btn-ghost" style={{ color: "var(--error)", padding: "4px 8px" }}
                    onClick={() => { if (confirm(`Delete user ${u.email}?`)) deleteUser.mutate(u.id); }}>
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="alert alert-info" style={{ marginTop: 16, fontSize: 12 }}>
        <strong>Roles:</strong>{" "}
        <strong>admin</strong> — full access &nbsp;|&nbsp;
        <strong>operator</strong> — create/run jobs &nbsp;|&nbsp;
        <strong>viewer</strong> — read-only
      </div>
    </div>
  );
}
