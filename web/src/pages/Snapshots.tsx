import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Snapshot, type SnapshotLog } from "../api/client.ts";
import { Camera, ChevronDown, ChevronUp, Trash2, RotateCcw, Lock } from "lucide-react";

export default function Snapshots() {
  const qc = useQueryClient();
  const { data: snapshots = [], isLoading } = useQuery({ queryKey: ["snapshots"], queryFn: () => api.listSnapshots(200) });
  const { data: agents = [] } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const { data: jobs = [] } = useQuery({ queryKey: ["jobs"], queryFn: api.listJobs });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [restoreDialog, setRestoreDialog] = useState<{ snapshotId: string } | null>(null);
  const [restorePath, setRestorePath] = useState("");
  const [restoreMsg, setRestoreMsg] = useState("");

  const deleteMut = useMutation({ mutationFn: api.deleteSnapshot, onSuccess: () => qc.invalidateQueries({ queryKey: ["snapshots"] }) });
  const restoreMut = useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) => api.restoreSnapshot(id, path),
    onSuccess: () => { setRestoreMsg("Restore triggered successfully."); },
    onError: (e: Error) => { setRestoreMsg(`Error: ${e.message}`); },
  });

  const filtered = statusFilter === "all" ? snapshots : snapshots.filter((s) => s.status === statusFilter);

  return (
    <div>
      <div className="page-header">
        <h1>Snapshots</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {["all", "success", "failed", "running"].map((s) => (
            <button key={s} className={statusFilter === s ? "btn-primary" : "btn-ghost"} style={{ padding: "6px 14px", textTransform: "capitalize" }}
              onClick={() => setStatusFilter(s)}>{s}</button>
          ))}
        </div>
      </div>

      {/* Restore Dialog */}
      {restoreDialog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div className="card" style={{ width: 440, background: "var(--bg-secondary)" }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Restore Snapshot</h3>
            {restoreMsg && <div className={`alert ${restoreMsg.startsWith("Error") ? "alert-error" : "alert-success"}`} style={{ marginBottom: 10 }}>{restoreMsg}</div>}
            <div className="form-group">
              <label>Restore to path</label>
              <input value={restorePath} onChange={(e) => setRestorePath(e.target.value)} placeholder="/tmp/restore" autoFocus />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-primary" disabled={!restorePath || restoreMut.isPending}
                onClick={() => { setRestoreMsg(""); restoreMut.mutate({ id: restoreDialog.snapshotId, path: restorePath }); }}>
                {restoreMut.isPending ? "Restoring…" : "Restore"}
              </button>
              <button className="btn-ghost" onClick={() => { setRestoreDialog(null); setRestorePath(""); setRestoreMsg(""); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><Camera size={40} /><p style={{ marginTop: 8 }}>No snapshots found</p></div></div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr><th>Started</th><th>Job</th><th>Agent</th><th>Status</th><th>Size</th><th>Duration</th><th>Retries</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const job = jobs.find((j) => j.id === s.jobId);
                const agent = agents.find((a) => a.id === s.agentId);

                // WORM lock state
                const wormLocked = (() => {
                  if (!job?.wormEnabled || !job.wormRetentionDays) return null;
                  const unlockMs = new Date(s.startedAt).getTime() + job.wormRetentionDays * 86_400_000;
                  if (Date.now() < unlockMs) return new Date(unlockMs);
                  return null;
                })();

                return (
                  <>
                    <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                      <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{fmt(s.startedAt)}</td>
                      <td style={{ fontWeight: 500 }}>
                        {job?.name ?? s.jobId.slice(0, 8)}
                        {job?.wormEnabled && (
                          <span title={wormLocked ? `Locked until ${wormLocked.toLocaleDateString()}` : "WORM (unlocked)"} style={{ marginLeft: 6, display: "inline-flex", verticalAlign: "middle" }}>
                            <Lock size={11} color={wormLocked ? "var(--warning, #f59e0b)" : "var(--text-muted)"} />
                          </span>
                        )}
                      </td>
                      <td style={{ color: "var(--text-muted)" }}>{agent?.name ?? s.agentId.slice(0, 8)}</td>
                      <td><StatusBadge status={s.status} /></td>
                      <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{s.sizeBytes ? fmtSize(s.sizeBytes) : "—"}</td>
                      <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{s.durationSeconds ? `${s.durationSeconds.toFixed(1)}s` : "—"}</td>
                      <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{s.retryCount}</td>
                      <td>
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          {expanded === s.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                          {s.status === "success" && (
                            <button className="btn-ghost" style={{ padding: "3px 6px" }} title="Restore"
                              onClick={(e) => { e.stopPropagation(); setRestoreDialog({ snapshotId: s.id }); setRestorePath(""); setRestoreMsg(""); }}>
                              <RotateCcw size={12} color="var(--primary)" />
                            </button>
                          )}
                          {wormLocked ? (
                            <span title={`WORM locked until ${wormLocked.toLocaleDateString()} — deletion not permitted`}
                              style={{ padding: "3px 6px", display: "inline-flex", alignItems: "center", opacity: 0.5, cursor: "not-allowed" }}>
                              <Lock size={12} color="var(--warning, #f59e0b)" />
                            </span>
                          ) : (
                            <button className="btn-ghost" style={{ padding: "3px 6px" }}
                              onClick={(e) => { e.stopPropagation(); if (confirm("Delete snapshot?")) deleteMut.mutate(s.id); }}>
                              <Trash2 size={12} color="var(--danger)" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded === s.id && (
                      <tr key={`${s.id}-detail`}>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <SnapshotDetail snapshot={s} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SnapshotDetail({ snapshot }: { snapshot: Snapshot }) {
  const { data: logs = [] } = useQuery({
    queryKey: ["snapshot-logs", snapshot.id],
    queryFn: () => api.getSnapshotLogs(snapshot.id),
    enabled: true,
  });

  return (
    <div style={{ padding: "12px 16px", background: "var(--bg)", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
        <div><div style={{ fontSize: 11, color: "var(--text-muted)" }}>Restic ID</div><code style={{ fontSize: 12 }}>{snapshot.resticSnapshotId?.slice(0, 12) ?? "—"}</code></div>
        <div><div style={{ fontSize: 11, color: "var(--text-muted)" }}>Files</div><div>{snapshot.fileCount ?? "—"}</div></div>
        <div><div style={{ fontSize: 11, color: "var(--text-muted)" }}>Finished</div><div style={{ fontSize: 12 }}>{snapshot.finishedAt ? fmt(snapshot.finishedAt) : "—"}</div></div>
        <div><div style={{ fontSize: 11, color: "var(--text-muted)" }}>Error</div><div style={{ fontSize: 12, color: "var(--danger)" }}>{snapshot.errorMessage ?? "—"}</div></div>
      </div>
      {logs.length > 0 && (
        <div style={{ background: "#0a0c12", borderRadius: "var(--radius)", padding: 10, maxHeight: 200, overflowY: "auto", fontFamily: "monospace", fontSize: 12 }}>
          {logs.map((l) => (
            <div key={l.id} style={{ color: l.level === "error" ? "var(--danger)" : l.level === "warn" ? "var(--warning)" : "var(--text-muted)", marginBottom: 2 }}>
              <span style={{ color: "var(--text-muted)", marginRight: 8 }}>{l.createdAt.split("T")[1]?.slice(0, 8)}</span>
              {l.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { success: "badge-success", failed: "badge-danger", running: "badge-primary", cancelled: "badge-muted" };
  return <span className={`badge ${map[status] ?? "badge-muted"}`}>{status}</span>;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtSize(bytes: number) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
