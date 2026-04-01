import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Settings as SettingsIcon, Mail, Shield, Users, Plus, Trash2, Webhook } from "lucide-react";
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
              { id: "general", label: "General", icon: SettingsIcon },
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
  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>General</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        General settings are configured via environment variables. See the <code>.env.example</code> file for all available options.
      </p>
      <div className="alert alert-info" style={{ marginTop: 16, fontSize: 12 }}>
        <strong>Key environment variables:</strong><br />
        <code>PORT</code> — server port (default: 3000)<br />
        <code>DATA_DIR</code> — data directory (default: ./data)<br />
        <code>MASTER_SECRET</code> — encryption master secret (required in production)<br />
        <code>CORS_ORIGIN</code> — allowed CORS origin for the web UI
      </div>
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
      <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save"}
      </button>
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
      </div>
    </div>
  );
}

function SsoSettings() {
  const [provider, setProvider] = useState("oidc");
  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Single Sign-On</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>Configure SSO providers. Requires Pro or Enterprise license.</p>
      <div className="form-group">
        <label>Provider</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="oidc">OIDC (OpenID Connect) — Google, Azure AD, Okta, Keycloak</option>
          <option value="saml">SAML 2.0 — ADFS, Enterprise IdPs</option>
          <option value="ldap">LDAP / Active Directory</option>
        </select>
      </div>
      {provider === "oidc" && (
        <>
          <div className="form-group"><label>Issuer URL</label><input placeholder="https://accounts.google.com" /></div>
          <div className="form-group"><label>Client ID</label><input /></div>
          <div className="form-group"><label>Client Secret</label><input type="password" /></div>
          <div className="form-group"><label>Redirect URI</label><input defaultValue="http://localhost:3000/api/auth/sso/oidc/callback" /></div>
        </>
      )}
      {provider === "saml" && (
        <>
          <div className="form-group"><label>IdP SSO URL</label><input placeholder="https://idp.example.com/saml/sso" /></div>
          <div className="form-group"><label>IdP Certificate (PEM)</label><textarea rows={4} /></div>
          <div className="form-group"><label>SP Entity ID / Issuer</label><input defaultValue="backuptool" /></div>
        </>
      )}
      {provider === "ldap" && (
        <>
          <div className="form-group"><label>LDAP URL</label><input placeholder="ldap://dc.example.com:389" /></div>
          <div className="form-group"><label>Bind DN</label><input placeholder="cn=service,dc=example,dc=com" /></div>
          <div className="form-group"><label>Bind Password</label><input type="password" /></div>
          <div className="form-group"><label>Search Base</label><input placeholder="dc=example,dc=com" /></div>
          <div className="form-group"><label>Search Filter</label><input defaultValue="(mail={{username}})" /></div>
        </>
      )}
      <div className="alert alert-info" style={{ fontSize: 12 }}>SSO is configured via environment variables. See <code>.env.example</code> for <code>OIDC_*</code>, <code>SAML_*</code>, and <code>LDAP_*</code> variables.</div>
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
