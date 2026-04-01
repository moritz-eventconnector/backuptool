import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Job } from "../api/client.ts";
import { Plus, Trash2, Play, Pencil, Briefcase, Lock } from "lucide-react";

export default function Jobs() {
  const qc = useQueryClient();
  const { data: jobs = [], isLoading } = useQuery({ queryKey: ["jobs"], queryFn: api.listJobs });
  const { data: agents = [] } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const { data: destinations = [] } = useQuery({ queryKey: ["destinations"], queryFn: api.listDestinations });
  const [showForm, setShowForm] = useState(false);
  const [editJob, setEditJob] = useState<Job | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);

  const deleteMut = useMutation({ mutationFn: api.deleteJob, onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }) });
  const runMut = useMutation({
    mutationFn: api.runJob,
    onSuccess: (d) => {
      setRunResult(`Backup started! Snapshot ID: ${d.snapshotId}`);
      setTimeout(() => setRunResult(null), 4000);
      qc.invalidateQueries({ queryKey: ["snapshots"] });
    },
  });

  return (
    <div>
      <div className="page-header">
        <h1>Backup Jobs</h1>
        <button className="btn-primary" onClick={() => { setEditJob(null); setShowForm(true); }}>
          <Plus size={15} style={{ marginRight: 6 }} />New Job
        </button>
      </div>

      {runResult && <div className="alert alert-success">{runResult}</div>}

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : jobs.length === 0 ? (
        <div className="card"><div className="empty-state"><Briefcase size={40} /><p style={{ marginTop: 8 }}>No backup jobs yet</p></div></div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr><th>Name</th><th>Agent</th><th>Schedule</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const agent = agents.find((a) => a.id === j.agentId);
                return (
                  <tr key={j.id}>
                    <td style={{ fontWeight: 500 }}>{j.name}</td>
                    <td style={{ color: "var(--text-muted)" }}>{agent?.name ?? j.agentId.slice(0, 8)}</td>
                    <td><code style={{ fontSize: 12, color: "var(--text-muted)" }}>{j.schedule ?? "Manual"}</code></td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <span className={`badge ${j.enabled ? "badge-success" : "badge-muted"}`}>
                          {j.enabled ? "Enabled" : "Disabled"}
                        </span>
                        {j.wormEnabled && (
                          <span className="badge badge-warning" title={`WORM: ${j.wormRetentionDays}d retention`} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <Lock size={10} /> WORM
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn-ghost" style={{ padding: "4px 8px" }} title="Run now"
                          onClick={() => runMut.mutate(j.id)} disabled={runMut.isPending}>
                          <Play size={13} color="var(--success)" />
                        </button>
                        <button className="btn-ghost" style={{ padding: "4px 8px" }} title="Edit"
                          onClick={() => { setEditJob(j); setShowForm(true); }}>
                          <Pencil size={13} />
                        </button>
                        <button className="btn-ghost" style={{ padding: "4px 8px" }} title="Delete"
                          onClick={() => { if (confirm(`Delete job "${j.name}"?`)) deleteMut.mutate(j.id); }}>
                          <Trash2 size={13} color="var(--danger)" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <JobFormModal
          job={editJob}
          agents={agents}
          destinations={destinations}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); qc.invalidateQueries({ queryKey: ["jobs"] }); }}
        />
      )}
    </div>
  );
}

function JobFormModal({ job, agents, destinations, onClose, onSaved }: {
  job: Job | null;
  agents: ReturnType<typeof api.listAgents> extends Promise<infer T> ? T : never;
  destinations: ReturnType<typeof api.listDestinations> extends Promise<infer T> ? T : never;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(job?.name ?? "");
  const [agentId, setAgentId] = useState(job?.agentId ?? agents[0]?.id ?? "");
  const [sourcePaths, setSourcePaths] = useState(job?.sourcePaths.join("\n") ?? "");
  const [destIds, setDestIds] = useState<string[]>(job?.destinationIds ?? []);
  const [schedule, setSchedule] = useState(job?.schedule ?? "");
  const [keepLast, setKeepLast] = useState(job?.retention?.keepLast?.toString() ?? "10");
  const [keepDaily, setKeepDaily] = useState(job?.retention?.keepDaily?.toString() ?? "7");
  const [keepWeekly, setKeepWeekly] = useState(job?.retention?.keepWeekly?.toString() ?? "4");
  const [keepMonthly, setKeepMonthly] = useState(job?.retention?.keepMonthly?.toString() ?? "12");
  const [preScript, setPreScript] = useState(job?.preScript ?? "");
  const [postScript, setPostScript] = useState(job?.postScript ?? "");
  const [excludePatterns, setExcludePatterns] = useState(job?.excludePatterns.join("\n") ?? "");
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [wormEnabled, setWormEnabled] = useState(job?.wormEnabled ?? false);
  const [wormDays, setWormDays] = useState(job?.wormRetentionDays?.toString() ?? "30");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!agentId) { setError("Please select an agent"); return; }
    if (destIds.length === 0) { setError("Please select at least one destination"); return; }
    setLoading(true);
    try {
      const data = {
        agentId, name,
        sourcePaths: sourcePaths.split("\n").map((s) => s.trim()).filter(Boolean),
        destinationIds: destIds,
        schedule: schedule || undefined,
        retention: {
          keepLast: parseInt(keepLast) || undefined,
          keepDaily: parseInt(keepDaily) || undefined,
          keepWeekly: parseInt(keepWeekly) || undefined,
          keepMonthly: parseInt(keepMonthly) || undefined,
        },
        preScript: preScript || undefined,
        postScript: postScript || undefined,
        excludePatterns: excludePatterns.split("\n").map((s) => s.trim()).filter(Boolean),
        enabled,
        wormEnabled,
        wormRetentionDays: parseInt(wormDays) || 0,
      };
      if (job) await api.updateJob(job.id, data);
      else await api.createJob(data);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{job ? "Edit Job" : "New Backup Job"}</h2>
          <button className="btn-ghost" style={{ padding: "4px 8px" }} onClick={onClose}>✕</button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group" style={{ gridColumn: "1/-1" }}>
              <label>Job Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily database backup" required />
            </div>
            <div className="form-group">
              <label>Agent</label>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.hostname})</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Schedule (cron)</label>
              <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 2 * * * (daily at 2am)" />
            </div>
            <div className="form-group" style={{ gridColumn: "1/-1" }}>
              <label>Source Paths (one per line)</label>
              <textarea value={sourcePaths} onChange={(e) => setSourcePaths(e.target.value)} rows={3} placeholder="/home/user/data&#10;/var/lib/database" required />
            </div>
            <div className="form-group" style={{ gridColumn: "1/-1" }}>
              <label>Destinations</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {destinations.map((d) => (
                  <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={destIds.includes(d.id)}
                      onChange={(e) => setDestIds(e.target.checked ? [...destIds, d.id] : destIds.filter((x) => x !== d.id))}
                    />
                    {d.name} <span className="badge badge-muted" style={{ fontSize: 11 }}>{d.type}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <details style={{ marginBottom: 16 }}>
            <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: 13 }}>Retention Policy</summary>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginTop: 12 }}>
              {[["keepLast", "Keep Last", keepLast, setKeepLast], ["keepDaily", "Daily", keepDaily, setKeepDaily], ["keepWeekly", "Weekly", keepWeekly, setKeepWeekly], ["keepMonthly", "Monthly", keepMonthly, setKeepMonthly]].map(([_k, label, val, setter]) => (
                <div className="form-group" key={_k as string}>
                  <label>{label as string}</label>
                  <input type="number" min="0" value={val as string} onChange={(e) => (setter as (v: string) => void)(e.target.value)} />
                </div>
              ))}
            </div>
          </details>

          <details style={{ marginBottom: 16 }}>
            <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: 13 }}>Scripts & Exclusions</summary>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="form-group">
                <label>Pre-backup Script</label>
                <textarea value={preScript} onChange={(e) => setPreScript(e.target.value)} rows={2} placeholder="#!/bin/bash&#10;pg_dump mydb > /tmp/db.sql" />
              </div>
              <div className="form-group">
                <label>Post-backup Script</label>
                <textarea value={postScript} onChange={(e) => setPostScript(e.target.value)} rows={2} placeholder="#!/bin/bash&#10;rm /tmp/db.sql" />
              </div>
              <div className="form-group">
                <label>Exclude Patterns (one per line)</label>
                <textarea value={excludePatterns} onChange={(e) => setExcludePatterns(e.target.value)} rows={2} placeholder="*.tmp&#10;node_modules/" />
              </div>
            </div>
          </details>

          <div className="form-group">
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", cursor: "pointer" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Job Enabled
            </label>
          </div>

          {/* WORM */}
          <details style={{ marginBottom: 16 }}>
            <summary style={{ cursor: "pointer", color: wormEnabled ? "var(--warning, #f59e0b)" : "var(--text-muted)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              <Lock size={13} /> Immutable Backups (WORM)
            </summary>
            <div style={{ marginTop: 12 }}>
              <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 12 }}>
                <strong>Write Once Read Many (WORM)</strong> prevents deletion of snapshots before the retention period expires. When combined with an <strong>S3 bucket with Object Lock enabled</strong>, restic writes every object in <code>COMPLIANCE</code> mode — making the data truly immutable even against admin deletion. Works with AWS S3, Wasabi, MinIO and any S3-compatible store that supports Object Lock.
              </div>
              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", cursor: "pointer" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={wormEnabled} onChange={(e) => setWormEnabled(e.target.checked)} />
                  Enable WORM (immutable backup retention)
                </label>
              </div>
              {wormEnabled && (
                <div className="form-group" style={{ maxWidth: 220 }}>
                  <label>Minimum retention (days)</label>
                  <input type="number" min="1" max="36500" value={wormDays}
                    onChange={(e) => setWormDays(e.target.value)}
                    placeholder="30" />
                  <small style={{ color: "var(--text-muted)", fontSize: 11 }}>
                    Snapshots cannot be deleted for this many days after creation.
                  </small>
                </div>
              )}
            </div>
          </details>

          <div className="modal-footer">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Saving..." : job ? "Update Job" : "Create Job"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
