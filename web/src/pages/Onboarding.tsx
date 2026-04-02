import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Shield, Check, ChevronRight, Server, Mail, Globe, Lock, SkipForward,
} from "lucide-react";
import { api } from "../api/client";

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "general", label: "General" },
  { id: "email", label: "Email" },
  { id: "sso", label: "SSO" },
  { id: "agent", label: "First Agent" },
  { id: "done", label: "Done" },
];

export default function Onboarding() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const skip = () => next();

  const finish = async () => {
    await api.saveAppConfig({ setupCompleted: true });
    qc.invalidateQueries({ queryKey: ["setup-status"] });
    navigate("/");
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", background: "var(--bg)" }}>
      {/* Sidebar steps */}
      <aside style={{ width: 220, background: "var(--bg-card)", borderRight: "1px solid var(--border)", padding: "32px 0", flexShrink: 0 }}>
        <div style={{ padding: "0 20px 24px" }}>
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, background: "rgba(99,102,241,.15)", borderRadius: 10, marginBottom: 12 }}>
            <Shield size={20} color="var(--primary)" />
          </div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Setup Wizard</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>Configure BackupTool</div>
        </div>

        {STEPS.map((s, i) => (
          <div key={s.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "9px 20px",
            background: i === step ? "rgba(99,102,241,.12)" : "transparent",
            borderLeft: i === step ? "3px solid var(--primary)" : "3px solid transparent",
            color: i < step ? "var(--success)" : i === step ? "var(--primary)" : "var(--text-muted)",
            fontSize: 13, fontWeight: i === step ? 600 : 400,
          }}>
            <span style={{ width: 20, height: 20, borderRadius: "50%", border: `1.5px solid ${i < step ? "var(--success)" : i === step ? "var(--primary)" : "var(--border)"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0 }}>
              {i < step ? <Check size={11} /> : i + 1}
            </span>
            {s.label}
          </div>
        ))}
      </aside>

      {/* Content */}
      <main style={{ flex: 1, padding: "48px 56px", maxWidth: 680 }}>
        {step === 0 && <StepWelcome onNext={next} />}
        {step === 1 && <StepGeneral onNext={next} onSkip={skip} />}
        {step === 2 && <StepEmail onNext={next} onSkip={skip} />}
        {step === 3 && <StepSso onNext={next} onSkip={skip} />}
        {step === 4 && <StepAgent onNext={next} onSkip={skip} />}
        {step === 5 && <StepDone onFinish={finish} />}
      </main>
    </div>
  );
}

// ── Step 0: Welcome ────────────────────────────────────────────────────────────

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Welcome to BackupTool</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 32, lineHeight: 1.6 }}>
        This wizard will guide you through the initial configuration. You can change all settings later in the Settings page.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 40 }}>
        {[
          { icon: Globe, title: "General settings", desc: "Server name, URL, and binary paths" },
          { icon: Mail, title: "Email notifications", desc: "SMTP configuration for backup alerts" },
          { icon: Lock, title: "Single Sign-On", desc: "OIDC / LDAP / SAML authentication" },
          { icon: Server, title: "First agent", desc: "Install the backup agent on your first server" },
        ].map((item) => (
          <div key={item.title} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(99,102,241,.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <item.icon size={16} color="var(--primary)" />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{item.title}</div>
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{item.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <button className="btn-primary" onClick={onNext} style={{ display: "flex", alignItems: "center", gap: 6 }}>
        Get started <ChevronRight size={15} />
      </button>
    </div>
  );
}

// ── Step 1: General ────────────────────────────────────────────────────────────

function StepGeneral({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [serverName, setServerName] = useState("BackupTool");
  const [serverUrl, setServerUrl] = useState("");
  const [resticBin, setResticBin] = useState("restic");
  const [rcloneBin, setRcloneBin] = useState("rclone");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.saveAppConfig({ serverName, serverUrl: serverUrl || undefined, resticBin, rcloneBin });
      onNext();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>General Settings</h2>
      <p style={{ color: "var(--text-muted)", marginBottom: 28, fontSize: 14 }}>
        Basic server configuration. These can be changed at any time in Settings → General.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="form-group">
          <label>Server Name</label>
          <input value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="BackupTool" />
          <small style={{ color: "var(--text-muted)", fontSize: 11 }}>Display name shown in the UI and notifications</small>
        </div>
        <div className="form-group">
          <label>Server URL <span style={{ color: "var(--text-muted)", fontSize: 12 }}>(optional)</span></label>
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://backup.example.com" />
          <small style={{ color: "var(--text-muted)", fontSize: 11 }}>Public URL used for SSO callbacks and install scripts</small>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="form-group">
            <label>Restic binary path</label>
            <input value={resticBin} onChange={(e) => setResticBin(e.target.value)} placeholder="restic" />
          </div>
          <div className="form-group">
            <label>Rclone binary path</label>
            <input value={rcloneBin} onChange={(e) => setRcloneBin(e.target.value)} placeholder="rclone" />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 32 }}>
        <button className="btn-primary" onClick={save} disabled={saving} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {saving ? "Saving…" : <>Save & continue <ChevronRight size={15} /></>}
        </button>
        <button className="btn-ghost" onClick={onSkip} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
          <SkipForward size={14} /> Skip for now
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Email ──────────────────────────────────────────────────────────────

function StepEmail({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [recipients, setRecipients] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.saveNotificationSettings({
        emailEnabled: enabled,
        emailRecipients: recipients.split(",").map((s) => s.trim()).filter(Boolean),
        notifyOnStart: false,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        smtpHost,
        smtpPort: parseInt(smtpPort, 10) || 587,
        smtpUser,
        smtpPass: smtpPass || undefined,
        smtpFrom,
      });
      onNext();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTestResult("");
    try {
      const r = await api.testNotification("email");
      setTestResult(r.message);
    } catch (e: unknown) {
      setTestResult("Error: " + (e instanceof Error ? e.message : "failed"));
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Email Notifications</h2>
      <p style={{ color: "var(--text-muted)", marginBottom: 28, fontSize: 14 }}>
        Receive email alerts when backups succeed or fail. Requires an SMTP server.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      {testResult && <div className={`alert ${testResult.startsWith("Error") ? "alert-error" : "alert-success"}`} style={{ marginBottom: 12 }}>{testResult}</div>}

      <div className="form-group">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "var(--text)" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable email notifications
        </label>
      </div>

      {enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
            <div className="form-group">
              <label>SMTP Host</label>
              <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div className="form-group">
              <label>Port</label>
              <input type="number" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group">
              <label>Username</label>
              <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="user@example.com" />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="••••••••" />
            </div>
          </div>
          <div className="form-group">
            <label>From address</label>
            <input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="backups@example.com" />
          </div>
          <div className="form-group">
            <label>Recipients (comma-separated)</label>
            <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="admin@example.com, ops@example.com" />
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 32 }}>
        <button className="btn-primary" onClick={save} disabled={saving} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {saving ? "Saving…" : <>Save & continue <ChevronRight size={15} /></>}
        </button>
        {enabled && (
          <button className="btn-ghost" onClick={sendTest} style={{ border: "1px solid var(--border)" }}>
            Send test email
          </button>
        )}
        <button className="btn-ghost" onClick={onSkip} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
          <SkipForward size={14} /> Skip
        </button>
      </div>
    </div>
  );
}

// ── Step 3: SSO ────────────────────────────────────────────────────────────────

function StepSso({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [provider, setProvider] = useState<"none" | "oidc" | "ldap">("none");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // OIDC fields
  const [issuerUrl, setIssuerUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");

  // LDAP fields
  const [ldapUrl, setLdapUrl] = useState("");
  const [bindDn, setBindDn] = useState("");
  const [bindCredentials, setBindCredentials] = useState("");
  const [searchBase, setSearchBase] = useState("dc=example,dc=com");
  const [searchFilter, setSearchFilter] = useState("(mail={{username}})");

  const save = async () => {
    if (provider === "none") { onNext(); return; }
    setSaving(true);
    setError("");
    try {
      if (provider === "oidc") {
        await api.saveSsoConfig("oidc", {
          enabled: true,
          config: { issuerUrl, clientId, clientSecret: clientSecret || undefined, redirectUri: redirectUri || undefined },
        });
      } else {
        await api.saveSsoConfig("ldap", {
          enabled: true,
          config: { url: ldapUrl, bindDn, bindCredentials: bindCredentials || undefined, searchBase, searchFilter },
        });
      }
      onNext();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Single Sign-On</h2>
      <p style={{ color: "var(--text-muted)", marginBottom: 28, fontSize: 14 }}>
        Optionally connect an identity provider so users can log in with their company account.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        {[
          { id: "none" as const, label: "Skip SSO" },
          { id: "oidc" as const, label: "OIDC" },
          { id: "ldap" as const, label: "LDAP / AD" },
        ].map((opt) => (
          <button
            key={opt.id}
            onClick={() => setProvider(opt.id)}
            className={provider === opt.id ? "btn-primary" : "btn-ghost"}
            style={{ border: provider === opt.id ? undefined : "1px solid var(--border)" }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {provider === "oidc" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="form-group">
            <label>Issuer URL</label>
            <input value={issuerUrl} onChange={(e) => setIssuerUrl(e.target.value)} placeholder="https://accounts.google.com" />
            <small style={{ color: "var(--text-muted)", fontSize: 11 }}>The OIDC discovery document will be fetched from /.well-known/openid-configuration</small>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group">
              <label>Client ID</label>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="my-client-id" />
            </div>
            <div className="form-group">
              <label>Client Secret</label>
              <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="••••••••" />
            </div>
          </div>
          <div className="form-group">
            <label>Redirect URI <span style={{ color: "var(--text-muted)", fontSize: 12 }}>(optional)</span></label>
            <input value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} placeholder="https://backup.example.com/api/auth/sso/oidc/callback" />
          </div>
        </div>
      )}

      {provider === "ldap" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="form-group">
            <label>LDAP URL</label>
            <input value={ldapUrl} onChange={(e) => setLdapUrl(e.target.value)} placeholder="ldap://ldap.example.com:389" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group">
              <label>Bind DN</label>
              <input value={bindDn} onChange={(e) => setBindDn(e.target.value)} placeholder="cn=admin,dc=example,dc=com" />
            </div>
            <div className="form-group">
              <label>Bind Password</label>
              <input type="password" value={bindCredentials} onChange={(e) => setBindCredentials(e.target.value)} placeholder="••••••••" />
            </div>
          </div>
          <div className="form-group">
            <label>Search Base</label>
            <input value={searchBase} onChange={(e) => setSearchBase(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Search Filter</label>
            <input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} />
            <small style={{ color: "var(--text-muted)", fontSize: 11 }}>Use {"{{username}}"} as placeholder for the login username</small>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 32 }}>
        <button className="btn-primary" onClick={save} disabled={saving} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {saving ? "Saving…" : provider === "none" ? <>Skip <ChevronRight size={15} /></> : <>Save & continue <ChevronRight size={15} /></>}
        </button>
        {provider !== "none" && (
          <button className="btn-ghost" onClick={onSkip} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
            <SkipForward size={14} /> Skip
          </button>
        )}
      </div>
    </div>
  );
}

// ── Step 4: First Agent ────────────────────────────────────────────────────────

function StepAgent({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [agentName, setAgentName] = useState("server-01");
  const [token, setToken] = useState<{ agentId: string; registrationToken: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    if (!agentName.trim()) return;
    setGenerating(true);
    setError("");
    try {
      const r = await api.generateAgentToken(agentName.trim());
      setToken(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to generate token");
    } finally {
      setGenerating(false);
    }
  };

  const installCmd = token
    ? `curl -fsSL https://get.backuptool.io/install.sh | sudo bash -s -- --token ${token.registrationToken}`
    : "";

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Install your first agent</h2>
      <p style={{ color: "var(--text-muted)", marginBottom: 28, fontSize: 14 }}>
        The agent runs on each server you want to back up. Generate a registration token and run the install command.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {!token ? (
        <div>
          <div className="form-group" style={{ maxWidth: 360 }}>
            <label>Agent name</label>
            <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="server-01" />
            <small style={{ color: "var(--text-muted)", fontSize: 11 }}>A friendly name for the server (e.g. web-01, db-prod)</small>
          </div>
          <button className="btn-primary" onClick={generate} disabled={generating || !agentName.trim()} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {generating ? "Generating…" : <>Generate install token <ChevronRight size={15} /></>}
          </button>
        </div>
      ) : (
        <div>
          <div className="alert alert-success" style={{ marginBottom: 20 }}>
            Token generated. Run this command on the target server:
          </div>
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px", fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", color: "var(--text)", marginBottom: 20 }}>
            {installCmd}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 24 }}>
            The agent will automatically register with the server after installation. You can also install agents manually later from the Agents page.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        {token && (
          <button className="btn-primary" onClick={onNext} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Continue <ChevronRight size={15} />
          </button>
        )}
        <button className="btn-ghost" onClick={onSkip} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
          <SkipForward size={14} /> {token ? "Skip" : "Skip for now"}
        </button>
      </div>
    </div>
  );
}

// ── Step 5: Done ───────────────────────────────────────────────────────────────

function StepDone({ onFinish }: { onFinish: () => void }) {
  return (
    <div style={{ textAlign: "center", paddingTop: 40 }}>
      <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 64, height: 64, background: "rgba(16,185,129,.12)", borderRadius: "50%", marginBottom: 24 }}>
        <Check size={28} color="var(--success)" />
      </div>
      <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>You're all set!</h2>
      <p style={{ color: "var(--text-muted)", maxWidth: 420, margin: "0 auto 40px", lineHeight: 1.6, fontSize: 14 }}>
        BackupTool is configured and ready. You can update any setting at any time from the Settings page.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", maxWidth: 320, margin: "0 auto 40px" }}>
        {[
          "Create backup jobs for your agents",
          "Configure storage destinations (S3, B2, local…)",
          "Monitor snapshots and restore files",
          "Set up webhook notifications",
        ].map((hint) => (
          <div key={hint} style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-muted)", fontSize: 13 }}>
            <Check size={13} color="var(--success)" style={{ flexShrink: 0 }} />
            {hint}
          </div>
        ))}
      </div>

      <button className="btn-primary" onClick={onFinish} style={{ padding: "10px 28px", fontSize: 15 }}>
        Go to Dashboard
      </button>
    </div>
  );
}
