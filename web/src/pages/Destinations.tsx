import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { Plus, Trash2, HardDrive, Pencil } from "lucide-react";

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
}

const EMPTY_FORM: FormState = { name: "", type: "s3", fields: {} };

export default function Destinations() {
  const qc = useQueryClient();
  const { data: destinations = [], isLoading } = useQuery({ queryKey: ["destinations"], queryFn: api.listDestinations });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const isEditing = !!form.id;

  const deleteMut = useMutation({
    mutationFn: api.deleteDestination,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["destinations"] }),
  });

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setError("");
    setShowForm(true);
  };

  const openEdit = async (id: string) => {
    setLoadingEdit(true);
    setError("");
    setShowForm(true);
    try {
      const dest = await api.getDestination(id);
      // Password fields come back as plain strings; show them so user can see/change
      setForm({ id, name: dest.name, type: dest.type, fields: dest.config ?? {} });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not load destination");
    } finally {
      setLoadingEdit(false);
    }
  };

  const handleTypeChange = (newType: string) => {
    const defaults: Record<string, string> = {};
    for (const f of CONFIG_FIELDS[newType] ?? []) {
      if (f.defaultValue) defaults[f.key] = f.defaultValue;
    }
    setForm((prev) => ({ ...prev, type: newType, fields: defaults }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      if (isEditing) {
        await api.updateDestination(form.id!, { name: form.name, type: form.type, config: form.fields });
      } else {
        await api.createDestination({ name: form.name, type: form.type, config: form.fields });
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
            <thead><tr><th>Name</th><th>Type</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {destinations.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 500 }}>{d.name}</td>
                  <td><span className="badge badge-primary">{DESTINATION_TYPES.find((t) => t.value === d.type)?.label ?? d.type}</span></td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{new Date(d.createdAt).toLocaleDateString()}</td>
                  <td style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    <button className="btn-ghost" style={{ padding: "4px 8px" }} title="Edit" onClick={() => openEdit(d.id)}>
                      <Pencil size={13} />
                    </button>
                    <button className="btn-ghost" style={{ padding: "4px 8px" }} title="Delete"
                      onClick={() => { if (confirm(`Delete "${d.name}"?`)) deleteMut.mutate(d.id); }}>
                      <Trash2 size={13} color="var(--danger)" />
                    </button>
                  </td>
                </tr>
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
