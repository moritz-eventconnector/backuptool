import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.tsx";
import { api } from "../api/client";
import logo from "../assets/logo.svg";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // TOTP step
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: unknown) {
      // If TOTP is required, the login() throws with totpToken attached
      if (err instanceof Error && err.message === "totp_required") {
        const token = (err as Error & { totpToken?: string }).totpToken;
        if (token) { setTotpToken(token); setLoading(false); return; }
      }
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totpToken) return;
    setError("");
    setLoading(true);
    try {
      await api.totpVerify(totpToken, totpCode);
      // Tokens are set via cookies — trigger a page navigation to bootstrap AuthContext
      navigate("/");
      window.location.reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ marginBottom: 16 }}>
            <img src={logo} alt="BackupTool" style={{ height: 60, width: 60, display: "inline-block" }} />
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>BackupTool</h1>
          <p style={{ color: "var(--text-muted)" }}>
            {totpToken ? "Two-factor authentication" : "Sign in to your account"}
          </p>
        </div>

        <div className="card">
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

          {totpToken ? (
            // ── TOTP code step ──────────────────────────────────────────────
            <form onSubmit={handleTotpSubmit}>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
                Enter the 6-digit code from your authenticator app.
              </p>
              <div className="form-group">
                <label>Authenticator code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  required
                  autoFocus
                  style={{ letterSpacing: "0.3em", fontSize: 20, textAlign: "center" }}
                />
              </div>
              <button type="submit" className="btn-primary" style={{ width: "100%", padding: "10px" }} disabled={loading || totpCode.length !== 6}>
                {loading ? "Verifying…" : "Verify"}
              </button>
              <button type="button" className="btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => { setTotpToken(null); setTotpCode(""); setError(""); }}>
                Back
              </button>
            </form>
          ) : (
            // ── Password step ───────────────────────────────────────────────
            <>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Email address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@example.com"
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                  />
                </div>
                <button type="submit" className="btn-primary" style={{ width: "100%", padding: "10px" }} disabled={loading}>
                  {loading ? "Signing in..." : "Sign in"}
                </button>
              </form>

              {/* SSO options */}
              <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
                <p style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>Or continue with</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <a href="/api/auth/sso/oidc/login" style={{ display: "block", padding: "9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", textAlign: "center", color: "var(--text)", fontSize: 14, fontWeight: 500 }}>
                    SSO (OIDC / OAuth2)
                  </a>
                  <a href="#ldap" onClick={(e) => { e.preventDefault(); }}
                    style={{ display: "block", padding: "9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", textAlign: "center", color: "var(--text)", fontSize: 14, fontWeight: 500 }}>
                    LDAP / Active Directory
                  </a>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
