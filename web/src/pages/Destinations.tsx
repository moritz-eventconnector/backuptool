import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { Plus, Trash2, HardDrive } from "lucide-react";

const DESTINATION_TYPES = [
  { value: "s3", label: "Amazon S3 / S3-Compatible" },
  { value: "b2", label: "Backblaze B2" },
  { value: "gcs", label: "Google Cloud Storage" },
  { value: "azure", label: "Azure Blob Storage" },
  { value: "sftp", label: "SFTP" },
  { value: "local", label: "Local Path" },
  { value: "wasabi", label: "Wasabi" },
  { value: "minio", label: "MinIO" },
  { value: "rclone", label: "Rclone (70+ providers)" },
];

const CONFIG_FIELDS: Record<string, Array<{ key: string; label: string; type?: string; placeholder?: string }>> = {
  s3: [
    { key: "bucket", label: "Bucket Name", placeholder: "my-backup-bucket" },
    { key: "region", label: "Region", placeholder: "us-east-1" },
    { key: "endpoint", label: "Endpoint (optional, for S3-compat)", placeholder: "https://..." },
    { key: "accessKeyId", label: "Access Key ID" },
    { key: "secretAccessKey", label: "Secret Access Key", type: "password" },
    { key: "path", label: "Path Prefix (optional)", placeholder: "backups/" },
  ],
  b2: [
    { key: "accountId", label: "Account ID" },
    { key: "applicationKey", label: "Application Key", type: "password" },
    { key: "bucket", label: "Bucket Name" },
    { key: "path", label: "Path Prefix (optional)" },
  ],
  local: [{ key: "path", label: "Local Path", placeholder: "/mnt/backup" }],
  sftp: [
    { key: "host", label: "Host" },
    { key: "port", label: "Port", placeholder: "22" },
    { key: "user", label: "Username" },
    { key: "password", label: "Password", type: "password" },
    { key: "path", label: "Remote Path", placeholder: "/backups" },
  ],
  gcs: [
    { key: "bucket", label: "Bucket" },
    { key: "credentialsJson", label: "Service Account JSON", type: "textarea" },
  ],
  rclone: [
    { key: "remote", label: "Rclone Remote", placeholder: "myremote:bucket/path" },
  ],
};

export default function Destinations() {
  const qc = useQueryClient();
  const { data: destinations = [], isLoading } = useQuery({ queryKey: ["destinations"], queryFn: api.listDestinations });
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState("s3");
  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const deleteMut = useMutation({ mutationFn: api.deleteDestination, onSuccess: () => qc.invalidateQueries({ queryKey: ["destinations"] }) });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.createDestination({ name, type, config: fields });
      setShowForm(false);
      setName(""); setFields({}); setType("s3");
      qc.invalidateQueries({ queryKey: ["destinations"] });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create destination");
    } finally {
      setLoading(false);
    }
  };

  const configFields = CONFIG_FIELDS[type] ?? [{ key: "config", label: "Configuration (JSON)" }];

  return (
    <div>
      <div className="page-header">
        <h1>Destinations</h1>
        <button className="btn-primary" onClick={() => setShowForm(true)}>
          <Plus size={15} style={{ marginRight: 6 }} />Add Destination
        </button>
      </div>

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : destinations.length === 0 ? (
        <div className="card"><div className="empty-state"><HardDrive size={40} /><p style={{ marginTop: 8 }}>No storage destinations configured</p><p style={{ fontSize: 12, marginTop: 4 }}>Supports S3, Backblaze B2, SFTP, GCS, Azure, and 70+ providers via Rclone</p></div></div>
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
                  <td><button className="btn-ghost" style={{ padding: "4px 8px" }}
                    onClick={() => { if (confirm(`Delete "${d.name}"?`)) deleteMut.mutate(d.id); }}>
                    <Trash2 size={13} color="var(--danger)" />
                  </button></td>
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
              <h2>Add Destination</h2>
              <button className="btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setShowForm(false)}>✕</button>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My S3 Bucket" required autoFocus />
              </div>
              <div className="form-group">
                <label>Type</label>
                <select value={type} onChange={(e) => { setType(e.target.value); setFields({}); }}>
                  {DESTINATION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {configFields.map((f) => (
                <div className="form-group" key={f.key}>
                  <label>{f.label}</label>
                  {f.type === "textarea" ? (
                    <textarea rows={4} value={fields[f.key] ?? ""} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} placeholder={f.placeholder} />
                  ) : (
                    <input type={f.type ?? "text"} value={fields[f.key] ?? ""} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} placeholder={f.placeholder} />
                  )}
                </div>
              ))}
              <div className="alert alert-info" style={{ fontSize: 12 }}>
                Credentials are encrypted with AES-256-GCM before storage.
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Saving..." : "Add Destination"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
