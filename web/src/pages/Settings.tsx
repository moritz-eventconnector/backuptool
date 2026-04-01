import { useState } from "react";
import { Settings as SettingsIcon, Mail, Shield, Users } from "lucide-react";

export default function Settings() {
  const [activeTab, setActiveTab] = useState("general");

  return (
    <div>
      <div className="page-header"><h1>Settings</h1></div>

      <div style={{ display: "flex", gap: 20 }}>
        {/* Tabs */}
        <div style={{ width: 180, flexShrink: 0 }}>
          <nav className="sidebar-nav" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {[
              { id: "general", label: "General", icon: SettingsIcon },
              { id: "notifications", label: "Notifications", icon: Mail },
              { id: "sso", label: "SSO / Auth", icon: Shield },
              { id: "users", label: "Users", icon: Users },
            ].map((t) => (
              <button key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`btn-ghost ${activeTab === t.id ? "active" : ""}`}
                style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8, background: activeTab === t.id ? "rgba(99,102,241,.15)" : "transparent", color: activeTab === t.id ? "var(--primary)" : "var(--text-muted)" }}>
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div style={{ flex: 1 }}>
          {activeTab === "general" && <GeneralSettings />}
          {activeTab === "notifications" && <NotificationSettings />}
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
      <div className="form-group">
        <label>Instance Name</label>
        <input defaultValue="My BackupTool Instance" />
      </div>
      <div className="form-group">
        <label>Max Concurrent Backups</label>
        <input type="number" min="1" max="10" defaultValue="2" />
      </div>
      <div className="form-group">
        <label>Log Retention (days)</label>
        <input type="number" min="1" defaultValue="90" />
      </div>
      <button className="btn-primary">Save Changes</button>
    </div>
  );
}

function NotificationSettings() {
  const [emailEnabled, setEmailEnabled] = useState(false);
  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Email Notifications</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>Configure SMTP to receive email alerts for backup events.</p>
      <div className="form-group">
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", cursor: "pointer" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} />
          Enable Email Notifications
        </label>
      </div>
      {emailEnabled && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group"><label>SMTP Host</label><input placeholder="smtp.example.com" /></div>
            <div className="form-group"><label>SMTP Port</label><input type="number" defaultValue="587" /></div>
            <div className="form-group"><label>Username</label><input placeholder="user@example.com" /></div>
            <div className="form-group"><label>Password</label><input type="password" placeholder="••••••••" /></div>
          </div>
          <div className="form-group"><label>From Address</label><input placeholder="backups@example.com" /></div>
          <div className="form-group"><label>Recipients (comma-separated)</label><input placeholder="admin@example.com, team@example.com" /></div>
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            {["On Start", "On Success", "On Failure"].map((e) => (
              <label key={e} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "var(--text)" }}>
                <input type="checkbox" style={{ width: "auto" }} defaultChecked={e !== "On Start"} /> {e}
              </label>
            ))}
          </div>
        </>
      )}
      <button className="btn-primary">Save</button>
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
      <div className="alert alert-info" style={{ fontSize: 12 }}>SSO configuration is also available via environment variables. See documentation.</div>
      <button className="btn-primary">Save SSO Configuration</button>
    </div>
  );
}

function UserSettings() {
  return (
    <div className="card">
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>User Management</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>User management via API or SSO provider. Roles: admin, operator, viewer.</p>
      <div style={{ marginTop: 16 }}>
        <div className="alert alert-info" style={{ fontSize: 12 }}>
          <strong>Roles:</strong><br />
          <strong>admin</strong> — full access, can manage agents, jobs, users, license<br />
          <strong>operator</strong> — can create/run jobs, manage destinations, view everything<br />
          <strong>viewer</strong> — read-only access to dashboard and snapshots
        </div>
      </div>
    </div>
  );
}
