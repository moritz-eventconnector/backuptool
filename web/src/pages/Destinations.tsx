import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { Plus, Trash2, HardDrive, Pencil, RefreshCw, CheckCircle, XCircle, Wifi, Lock } from "lucide-react";

// Destination types that support S3 Object Lock
const S3_OBJECT_LOCK_TYPES = ["s3", "wasabi", "minio"];

const DESTINATION_TYPES = [
  { value: "s3",     label: "Amazon S3 / S3-Compatible" },
  { value: "b2",     label: "Backblaze B2 (S3-compatible)" },
  { value: "wasabi", label: "Wasabi" },
  { value: "minio",  label: "MinIO" },
  { value: "gcs",    label: "Google Cloud Storage" },
  { value: "sftp",   label: "SFTP" },
  { value: "local",  label: "Local Path" },
  { value: "rclone", label: "Rclone (70+ providers)" },
];

type FieldDef = { key: string; label: string; type?: string; placeholder?: string; defaultValue?: string; required?: boolean };

const CONFIG_FIELDS: Record<string, FieldDef[]> = {
  s3: [
    { key: "bucket",          label: "Bucket Name",              placeholder: "my-backup-bucket",       required: true },
    { key: "region",          label: "Region",                   placeholder: "us-east-1" },
    { key: "endpoint",        label: "Endpoint (S3-compatible)", placeholder: "https://s3.example.com" },
    { key: "accessKeyId",     label: "Access Key ID",            required: true },
    { key: "secretAccessKey", label: "Secret Access Key",        type: "password", required: true },
    { key: "path",            label: "Path Prefix (optional)",   placeholder: "backups/" },
  ],
  // Backblaze B2 via its S3-compatible API (recommended)
  b2: [
    { key: "endpoint",        label: "S3 Endpoint",              placeholder: "s3.eu-central-003.backblazeb2.com", required: true },
    { key: "bucket",          label: "Bucket Name",              required: true },
    { key: "accessKeyId",     label: "Key ID",                   required: true },
    { key: "secretAccessKey", label: "Application Key",          type: "password", required: true },
    { key: "path",            label: "Path Prefix (optional)",   placeholder: "backups/" },
  ],
  wasabi: [
    { key: "endpoint",        label: "Endpoint",                 placeholder: "s3.eu-central-2.wasabisys.com", required: true },
    { key: "bucket",          label: "Bucket Name",              required: true },
    { key: "region",          label: "Region",                   placeholder: "eu-central-2" },
    { key: "accessKeyId",     label: "Access Key",               required: true },
    { key: "secretAccessKey", label: "Secret Key",               type: "password", required: true },
    { key: "path",            label: "Path Prefix (optional)",   placeholder: "backups/" },
  ],
  minio: [
    { key: "endpoint",        label: "Endpoint",                 placeholder: "https://minio.example.com", required: true },
    { key: "bucket",          label: "Bucket Name",              required: true },
    { key: "accessKeyId",     label: "Access Key",               required: true },
    { key: "secretAccessKey", label: "Secret Key",               type: "password", required: true },
    { key: "path",            label: "Path Prefix (optional)",   placeholder: "backups/" },
  ],
  local: [
    { key: "path", label: "Local Path", placeholder: "/var/lib/backuptool-agent/repos/myjob", defaultValue: "/var/lib/backuptool-agent/repos/", required: true },
  ],
  sftp: [
    { key: "host",     label: "Host",        required: true },
    { key: "port",     label: "Port",        placeholder: "22" },
    { key: "user",     label: "Username",    required: true },
    { key: "password", label: "Password",    type: "password" },
    { key: "path",     label: "Remote Path", placeholder: "/backups", required: true },
  ],
  gcs: [
    { key: "bucket",          label: "Bucket",                 required: true },
    { key: "credentialsJson", label: "Service Account JSON",   type: "textarea", required: true },
  ],
  rclone: [
    { key: "remote", label: "Rclone Remote", placeholder: "myremote:bucket/path", required: true },
  ],
};

interface FormState {
  id?: string;
  name: string;
  type: string;
  fields: Record<string, string>;
  wormEnabled: boolean;
  wormRetentionDays: string;
  wormMode: "COMPLIANCE" | "GOVERNANCE";
}

const EMPTY_FORM: FormState = { name: "", type: "s3", fields: {}, wormEnabled: false, wormRetentionDays: "30", wormMode: "COMPLIANCE" };

export default function Destinations() {
  const qc = useQueryClient();
  const { data: destinations = [], isLoading } = useQuery({ queryKey: ["destinations"], queryFn: api.listDestinations });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const isEditing = !!form.id;

  const deleteMut = useMutation({
    mutationFn: api.deleteDestination,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["destinations"] }),
  });

  const [resetMsg, setResetMsg] = useState<Record<string, string>>({});
  const resetMut = useMutation({
    mutationFn: (id: string) => api.resetDestinationRepo(id),
    onSuccess: (data, id) => {
      setResetMsg((prev) => ({ ...prev, [id]: `Repo reset — new path: ${data.newPath}` }));
      qc.invalidateQueries({ queryKey: ["destinations"] });
    },
    onError: (e: Error, id) => {
      setResetMsg((prev) => ({ ...prev, [id]: `Error: ${e.message}` }));
    },
  });

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setError("");
    setTestResult(null);
    setShowForm(true);
  };

  const openEdit = async (id: string) => {
    setLoadingEdit(true);
    setError("");
    setTestResult(null);
    setShowForm(true);
    try {
      const dest = await api.getDestination(id);
      // Password fields come back as plain strings; show them so user can see/change
      setForm({
        id, name: dest.name, type: dest.type, fields: dest.config ?? {},
        wormEnabled: dest.wormEnabled ?? false,
        wormRetentionDays: String(dest.wormRetentionDays ?? 30),
        wormMode: dest.wormMode ?? "COMPLIANCE",
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not load destination");
    } finally {
      setLoadingEdit(false);
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    setTesting(true);
    try {
      const result = await api.testDestination(form.type, form.fields);
      setTestResult(result);
    } catch (e: unknown) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleTypeChange = (newType: string) => {
    const defaults: Record<string, string> = {};
    for (const f of CONFIG_FIELDS[newType] ?? []) {
      if (f.defaultValue) defaults[f.key] = f.defaultValue;
    }
    setForm((prev) => ({ ...prev, type: newType, fields: defaults, wormEnabled: false }));
    setTestResult(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const wormPayload = S3_OBJECT_LOCK_TYPES.includes(form.type) ? {
        wormEnabled: form.wormEnabled,
        wormRetentionDays: parseInt(form.wormRetentionDays) || 0,
        wormMode: form.wormMode,
      } : { wormEnabled: false, wormRetentionDays: 0, wormMode: "COMPLIANCE" as const };
      if (isEditing) {
        await api.updateDestination(form.id!, { name: form.name, type: form.type, config: form.fields, ...wormPayload });
      } else {
        await api.createDestination({ name: form.name, type: form.type, config: form.fields, ...wormPayload });
      }
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ["destinations"] });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save destination");
    } finally {
      setSaving(false);
    }
  };

  const configFields = CONFIG_FIELDS[form.type] ?? [{ key: "config", label: "Configuration (JSON)" }];

  return (
    <div>
      <div className="page-header">
        <h1>Destinations</h1>
        <button className="btn-primary" onClick={openAdd}>
          <Plus size={15} style={{ marginRight: 6 }} />Add Destination
        </button>
      </div>

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : destinations.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <HardDrive size={40} />
            <p style={{ marginTop: 8 }}>No storage destinations configured</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>Supports S3, Backblaze B2, Wasabi, MinIO, SFTP, GCS, and 70+ providers via Rclone</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Repository path</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {destinations.map((d) => (
                <>
                  <tr key={d.id}>
                    <td style={{ fontWeight: 500 }}>{d.name}</td>
                    <td>
                      <span className="badge badge-primary">{DESTINATION_TYPES.find((t) => t.value === d.type)?.label ?? d.type}</span>
                      {d.wormEnabled && (
                        <span className="badge badge-warning" style={{ marginLeft: 4 }} title={`S3 Object Lock: ${d.wormRetentionDays}d ${d.wormMode}`}>
                          <Lock size={10} style={{ marginRight: 3 }} />Object Lock
                        </span>
                      )}
                    </td>
                    <td style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={d.repoSummary}>
                      {d.repoSummary || "—"}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{new Date(d.createdAt).toLocaleDateString()}</td>
                    <td style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button className="btn-ghost" style={{ padding: "4px 8px" }} title="Edit" onClick={() => openEdit(d.id)}>
                        <Pencil size={13} />
                      </button>
                      <button className="btn-ghost" style={{ padding: "4px 8px" }}
                        title="Reset repository — fixes 'wrong password' error by starting a fresh restic repo on the next backup"
                        onClick={() => {
                          if (confirm(`Reset the restic repository for "${d.name}"?\n\nA fresh repository will be initialised on the next backup. All existing snapshots for this destination will be marked as orphaned (no longer restorable).`)) {
                            setResetMsg((prev) => ({ ...prev, [d.id]: "" }));
                            resetMut.mutate(d.id);
                          }
                        }}>
                        <RefreshCw size={13} color="var(--warning, #f59e0b)" />
                      </button>
                      <button className="btn-ghost" style={{ padding: "4px 8px" }} title="Delete"
                        onClick={() => { if (confirm(`Delete "${d.name}"?`)) deleteMut.mutate(d.id); }}>
                        <Trash2 size={13} color="var(--danger)" />
                      </button>
                    </td>
                  </tr>
                  {resetMsg[d.id] && (
                    <tr key={`${d.id}-msg`}>
                      <td colSpan={5} style={{ padding: "4px 12px 8px", fontSize: 12, color: resetMsg[d.id].startsWith("Error") ? "var(--danger)" : "var(--success, #22c55e)" }}>
                        {resetMsg[d.id]}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{isEditing ? "Edit Destination" : "Add Destination"}</h2>
              <button className="btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setShowForm(false)}>✕</button>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            {loadingEdit ? (
              <div style={{ textAlign: "center", padding: 32 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Name</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="My Backup Storage" required autoFocus />
                </div>
                <div className="form-group">
                  <label>Type</label>
                  <select value={form.type} onChange={(e) => handleTypeChange(e.target.value)} disabled={isEditing}>
                    {DESTINATION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  {isEditing && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Type cannot be changed after creation.</div>}
                </div>
                {configFields.map((f) => (
                  <div className="form-group" key={f.key}>
                    <label>{f.label}{f.required && <span style={{ color: "var(--danger)", marginLeft: 2 }}>*</span>}</label>
                    {f.type === "textarea" ? (
                      <textarea rows={4} value={form.fields[f.key] ?? ""} placeholder={f.placeholder}
                        onChange={(e) => setForm({ ...form, fields: { ...form.fields, [f.key]: e.target.value } })} />
                    ) : (
                      <input type={f.type ?? "text"} value={form.fields[f.key] ?? ""} placeholder={f.placeholder}
                        onChange={(e) => setForm({ ...form, fields: { ...form.fields, [f.key]: e.target.value } })} />
                    )}
                  </div>
                ))}
                {form.type === "b2" && (
                  <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 8 }}>
                    Find your S3 endpoint in the Backblaze console under Buckets → Endpoint.
                    Example: <code>s3.eu-central-003.backblazeb2.com</code>
                  </div>
                )}
                {form.type === "local" && (
                  <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 8 }}>
                    Path must be writable by the agent (runs as root). The directory
                    <code> /var/lib/backuptool-agent/repos/</code> is always available.
                  </div>
                )}
                <div className="alert alert-info" style={{ fontSize: 12 }}>
                  Credentials are encrypted with AES-256-GCM before storage.
                </div>

                {/* S3 Object Lock (destination-level WORM) */}
                {S3_OBJECT_LOCK_TYPES.includes(form.type) && (
                  <details style={{ marginBottom: 16 }} open={form.wormEnabled}>
                    <summary style={{ cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", gap: 6,
                      color: form.wormEnabled ? "var(--warning, #f59e0b)" : "var(--text-muted)" }}>
                      <Lock size={13} /> S3 Object Lock (storage-level immutability)
                    </summary>
                    <div style={{ marginTop: 12 }}>
                      <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 12 }}>
                        <strong>S3 Object Lock</strong> writes every restic object with an immutability header
                        directly on S3 — even an admin cannot delete the data until the retention period expires.
                        Requires the bucket to be created with Object Lock enabled.
                        <br /><br />
                        This is separate from the <strong>job-level WORM</strong> (which only prevents deletion
                        inside BackupTool's UI).
                      </div>
                      <div className="form-group">
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <input type="checkbox" style={{ width: "auto" }} checked={form.wormEnabled}
                            onChange={(e) => setForm({ ...form, wormEnabled: e.target.checked })} />
                          Enable S3 Object Lock on this destination
                        </label>
                      </div>
                      {form.wormEnabled && (<>
                        <div className="form-group" style={{ maxWidth: 220 }}>
                          <label>Retention period (days)</label>
                          <input type="number" min="1" max="36500" value={form.wormRetentionDays}
                            onChange={(e) => setForm({ ...form, wormRetentionDays: e.target.value })}
                            placeholder="30" />
                        </div>
                        <div className="form-group">
                          <label>Lock mode</label>
                          <select value={form.wormMode} onChange={(e) => setForm({ ...form, wormMode: e.target.value as "COMPLIANCE" | "GOVERNANCE" })}>
                            <option value="COMPLIANCE">COMPLIANCE — cannot be overridden by anyone</option>
                            <option value="GOVERNANCE">GOVERNANCE — admins with special permissions can override</option>
                          </select>
                        </div>
                      </>)}
                    </div>
                  </details>
                )}

                {/* Connection test */}
                <div style={{ marginBottom: 16 }}>
                  <button type="button" className="btn-ghost"
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", justifyContent: "center", border: "1px solid var(--border)" }}
                    disabled={testing}
                    onClick={handleTest}>
                    {testing
                      ? <><span className="spinner" style={{ width: 13, height: 13 }} />Testing…</>
                      : <><Wifi size={14} />Test Connection</>}
                  </button>
                  {testResult && (
                    <div style={{
                      marginTop: 8, padding: "8px 12px", borderRadius: "var(--radius)",
                      background: testResult.ok ? "rgba(34,197,94,.1)" : "rgba(239,68,68,.1)",
                      border: `1px solid ${testResult.ok ? "rgba(34,197,94,.3)" : "rgba(239,68,68,.3)"}`,
                      display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13,
                    }}>
                      {testResult.ok
                        ? <CheckCircle size={15} color="var(--success, #22c55e)" style={{ flexShrink: 0, marginTop: 1 }} />
                        : <XCircle size={15} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />}
                      <span style={{ color: testResult.ok ? "var(--success, #22c55e)" : "var(--danger)" }}>
                        {testResult.message}
                      </span>
                    </div>
                  )}
                </div>

                <div className="modal-footer">
                  <button type="button" className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? "Saving..." : isEditing ? "Save Changes" : "Add Destination"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
