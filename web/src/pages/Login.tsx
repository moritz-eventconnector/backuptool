import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.tsx";
import { config } from "../config.ts";
import logo from "../assets/logo.svg";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
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
          <p style={{ color: "var(--text-muted)" }}>Sign in to your account</p>
        </div>

        <div className="card">
          {error && <div className="alert alert-error">{error}</div>}
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
              <a href="#ldap" onClick={(e) => { e.preventDefault(); /* show LDAP modal */ }}
                style={{ display: "block", padding: "9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", textAlign: "center", color: "var(--text)", fontSize: 14, fontWeight: 500 }}>
                LDAP / Active Directory
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
