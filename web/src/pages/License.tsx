import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { Key, Upload, CheckCircle, AlertTriangle, Crown, Copy, Fingerprint } from "lucide-react";

const EDITION_FEATURES: Record<string, string[]> = {
  community: ["1 agent", "Local + S3 backups", "Basic scheduling", "Email notifications", "Community support"],
  pro: ["Seat-based agents (per license)", "Multiple user accounts", "All storage providers", "Email support"],
  enterprise: ["Unlimited agents", "All storage providers", "SSO (OIDC + SAML + LDAP)", "Kubernetes agent", "WORM backups", "Audit logging", "Priority support"],
};

export default function LicensePage() {
  const qc = useQueryClient();
  const { data: lic, isLoading } = useQuery({ queryKey: ["license"], queryFn: api.getLicense });
  const [licenseText, setLicenseText] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const uploadMut = useMutation<{ message: string }, Error, void>({
    mutationFn: () => api.uploadLicense(licenseText.trim()),
    onSuccess: (data: { message: string }) => {
      setSuccess(data.message ?? "License activated!");
      setLicenseText("");
      qc.invalidateQueries({ queryKey: ["license"] });
      setTimeout(() => setSuccess(""), 4000);
    },
    onError: (err: Error) => setError(err.message),
  });

  const removeMut = useMutation({
    mutationFn: api.deleteLicense,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["license"] }),
  });

  if (isLoading) return <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>;

  const edition = lic?.edition ?? "community";
  const editionColor = { community: "var(--text-muted)", pro: "var(--primary)", enterprise: "#f59e0b" }[edition] ?? "var(--text-muted)";

  return (
    <div>
      <div className="page-header"><h1>License</h1></div>

      {/* Expired license warning */}
      {lic?.expiresAt && new Date(lic.expiresAt) < new Date() && (
        <div className="alert alert-error" style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
          <AlertTriangle size={18} />
          <div>
            <strong>License expired on {new Date(lic.expiresAt).toLocaleDateString()}.</strong>
            {" "}New backups are blocked. Restores remain fully available. Upload a renewed license to resume backups.
          </div>
        </div>
      )}

      {/* Current License */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: `${editionColor}20`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Crown size={22} color={editionColor} />
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, textTransform: "capitalize", color: editionColor }}>{edition} Edition</div>
            {lic?.customerName && <div style={{ color: "var(--text-muted)" }}>{lic.customerName}</div>}
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            {lic?.seats && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{lic.seats === 0 ? "Unlimited" : lic.seats} agents</div>}
            {lic?.expiresAt ? (
              <div style={{ fontSize: 13, color: new Date(lic.expiresAt) < new Date() ? "var(--danger)" : "var(--text-muted)" }}>
                {new Date(lic.expiresAt) < new Date() ? "Expired" : "Expires"}: {new Date(lic.expiresAt).toLocaleDateString()}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Perpetual License</div>
            )}
          </div>
        </div>

        {/* Features */}
        <div style={{ marginTop: 20, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(EDITION_FEATURES[edition] ?? []).map((f) => (
            <div key={f} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)", background: "var(--bg)", padding: "4px 10px", borderRadius: 16 }}>
              <CheckCircle size={12} color="var(--success)" /> {f}
            </div>
          ))}
        </div>

        {lic?.source === "uploaded" && edition !== "community" && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <button className="btn-ghost" style={{ color: "var(--danger)" }} onClick={() => { if (confirm("Remove license and revert to Community?")) removeMut.mutate(); }}>
              Remove License
            </button>
          </div>
        )}
      </div>

      {/* Edition Comparison */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        {(["community", "pro", "enterprise"] as const).map((ed) => (
          <div key={ed} className="card" style={{ borderColor: ed === edition ? editionColor : "var(--border)" }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4, textTransform: "capitalize" }}>{ed}</div>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 12 }}>
              {ed === "community" ? "Free, forever" : ed === "pro" ? "For teams" : "For enterprises"}
            </div>
            {EDITION_FEATURES[ed].map((f) => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 6, color: "var(--text-muted)" }}>
                <CheckCircle size={12} color="var(--success)" /> {f}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Server Fingerprint */}
      {lic?.fingerprint && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
            <Fingerprint size={15} /> Server Fingerprint
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>
            Copy this value and paste it into the <strong>--fingerprint</strong> field when generating a license for this server.
            Licenses with a matching fingerprint can only be used on this server.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code style={{ flex: 1, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 12px", fontFamily: "monospace", fontSize: 12, color: "var(--primary)", wordBreak: "break-all" }}>
              {lic.fingerprint}
            </code>
            <button
              className="btn-ghost"
              style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--border)" }}
              onClick={() => { navigator.clipboard.writeText(lic.fingerprint!); }}
              title="Copy fingerprint"
            >
              <Copy size={13} /> Copy
            </button>
          </div>
        </div>
      )}

      {/* Upload License */}
      <div className="card">
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
          <Upload size={15} /> {edition === "community" ? "Activate License" : "Replace License"}
        </h2>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
          Paste your license key below. License verification is fully offline — your server never phones home.
        </p>
        {error && <div className="alert alert-error"><AlertTriangle size={14} style={{ marginRight: 6 }} />{error}</div>}
        {success && <div className="alert alert-success"><CheckCircle size={14} style={{ marginRight: 6 }} />{success}</div>}
        <div className="form-group">
          <label>License Key (JWT)</label>
          <textarea
            value={licenseText}
            onChange={(e) => { setLicenseText(e.target.value); setError(""); }}
            rows={5}
            placeholder="eyJhbGciOiJFZERTQSJ9..."
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
        </div>
        <button className="btn-primary" disabled={!licenseText.trim() || uploadMut.isPending} onClick={() => uploadMut.mutate()}>
          {uploadMut.isPending ? "Verifying..." : "Activate License"}
        </button>
      </div>
    </div>
  );
}
