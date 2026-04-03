import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { useEffect, useRef, useState } from "react";
import { config } from "../config.ts";
import { CheckCircle, XCircle, Clock, Server, Activity, Trash2, HardDrive, AlertTriangle, ShieldCheck, ShieldAlert } from "lucide-react";

interface ProgressInfo {
  snapshotId: string;
  jobId?: string;
  agentId: string;
  percent: number;
  filesDone: number;
  filesNew: number;
  sizeDone: number;
  sizeTotal: number;
  startedAt: number;
}

interface ActivityEvent {
  type: string;
  agentId?: string;
  snapshotId?: string;
  jobId?: string;
  jobName?: string;
  status?: string;
  message?: string;
  ts: number;
}

interface OverdueJob {
  jobId: string;
  jobName: string;
  agentId: string;
  prevRun: string;
  lastSuccessAt: string | null;
}

export default function Dashboard() {
  const qc = useQueryClient();
  const { data: agents = [] } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const { data: snapshots = [] } = useQuery({ queryKey: ["snapshots"], queryFn: () => api.listSnapshots(50) });
  const { data: jobs = [] } = useQuery({ queryKey: ["jobs"], queryFn: api.listJobs });
  const { data: overdueJobs = [] } = useQuery({
    queryKey: ["overdue-jobs"],
    queryFn: api.getOverdueJobs,
    refetchInterval: 5 * 60 * 1000, // re-check every 5 min
  });
  const deleteMut = useMutation({
    mutationFn: api.deleteAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  const [runningJobs, setRunningJobs] = useState<Record<string, ProgressInfo>>({});
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [liveOverdue, setLiveOverdue] = useState<OverdueJob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(config.wsUrl);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "ui_connect" }));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "progress") {
          setRunningJobs((prev) => ({
            ...prev,
            [msg.snapshotId]: {
              snapshotId: msg.snapshotId,
              agentId: msg.agentId,
              percent: msg.percent ?? 0,
              filesDone: msg.filesDone ?? 0,
              filesNew: msg.filesNew ?? 0,
              sizeDone: msg.sizeDone ?? 0,
              sizeTotal: msg.sizeTotal ?? 0,
              startedAt: prev[msg.snapshotId]?.startedAt ?? Date.now(),
            },
          }));
        } else if (msg.type === "snapshot_done") {
          setRunningJobs((prev) => {
            const next = { ...prev };
            delete next[msg.snapshotId];
            return next;
          });
          qc.invalidateQueries({ queryKey: ["snapshots"] });
          qc.invalidateQueries({ queryKey: ["overdue-jobs"] });
          setActivity((prev) => [{ type: "snapshot_done", snapshotId: msg.snapshotId, status: msg.status, agentId: msg.agentId, ts: Date.now() }, ...prev].slice(0, 10));
        } else if (msg.type === "agent_status") {
          qc.invalidateQueries({ queryKey: ["agents"] });
          setActivity((prev) => [{ type: "agent_status", agentId: msg.agentId, status: msg.status, ts: Date.now() }, ...prev].slice(0, 10));
        } else if (msg.type === "check_result") {
          const evtStatus = msg.status === "passed" ? "check_passed" : "check_failed";
          setActivity((prev) => [{ type: evtStatus, snapshotId: msg.snapshotId, agentId: msg.agentId, ts: Date.now() }, ...prev].slice(0, 10));
        } else if (msg.type === "backup_overdue") {
          setLiveOverdue((prev) => {
            if (prev.some((j: OverdueJob) => j.jobId === msg.jobId)) return prev;
            return [...prev, { jobId: msg.jobId, jobName: msg.jobName, agentId: msg.agentId, prevRun: msg.prevRun, lastSuccessAt: msg.lastSuccessAt ?? null }];
          });
        }
      } catch { /**/ }
    };
    return () => ws.close();
  }, [qc]);

  const online = agents.filter((a) => a.status === "online" || a.status === "busy").length;
  const successToday = snapshots.filter((s) => s.status === "success" && isToday(s.startedAt)).length;
  const failedToday = snapshots.filter((s) => s.status === "failed" && isToday(s.startedAt)).length;
  const activeRunning = Object.keys(runningJobs).length;

  // Merge server-fetched overdue with live WebSocket-pushed overdue
  const allOverdue: OverdueJob[] = [
    ...overdueJobs,
    ...liveOverdue.filter((l) => !overdueJobs.some((o) => o.jobId === l.jobId)),
  ];

  return (
    <div>
      <div className="page-header"><h1>Dashboard</h1></div>

      {/* Overdue backup warnings */}
      {allOverdue.length > 0 && (
        <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {allOverdue.map((j) => (
            <div key={j.jobId} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", borderRadius: "var(--radius)",
              background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.3)",
              color: "var(--danger)",
            }}>
              <AlertTriangle size={15} style={{ flexShrink: 0 }} />
              <div style={{ fontSize: 13, flex: 1 }}>
                <strong>{j.jobName}</strong> — backup overdue since{" "}
                <strong>{new Date(j.prevRun).toLocaleString()}</strong>
                {j.lastSuccessAt
                  ? `. Last success: ${new Date(j.lastSuccessAt).toLocaleString()}`
                  : ". Never ran successfully."}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="label">Agents Online</div>
          <div className="value" style={{ color: online > 0 ? "var(--success)" : "var(--text-muted)" }}>{online}/{agents.length}</div>
        </div>
        <div className="stat-card">
          <div className="label">Backups Today</div>
          <div className="value">{successToday}</div>
        </div>
        <div className="stat-card">
          <div className="label">Failures Today</div>
          <div className="value" style={{ color: failedToday > 0 ? "var(--danger)" : "var(--text-muted)" }}>{failedToday}</div>
        </div>
        <div className="stat-card">
          <div className="label">Running Now</div>
          <div className="value" style={{ color: activeRunning > 0 ? "var(--primary)" : "var(--text-muted)" }}>{activeRunning}</div>
        </div>
        <div className="stat-card">
          <div className="label">Active Jobs</div>
          <div className="value">{jobs.filter((j) => j.enabled).length}</div>
        </div>
      </div>

      {/* Active Backups with progress bars */}
      {activeRunning > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
            <Activity size={15} color="var(--primary)" />
            <span>Active Backups</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 2 }}>— live</span>
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {Object.values(runningJobs).map((p) => {
              const agent = agents.find((a) => a.id === p.agentId);
              const elapsed = Math.floor((Date.now() - p.startedAt) / 1000);
              return (
                <div key={p.snapshotId}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 13 }}>
                    <div style={{ fontWeight: 500 }}>
                      {agent?.name ?? p.agentId.slice(0, 8)}
                      <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
                        {p.filesDone.toLocaleString()} / {p.filesNew.toLocaleString()} files
                        {p.sizeTotal > 0 && ` · ${fmtSize(p.sizeDone)} / ${fmtSize(p.sizeTotal)}`}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 12, color: "var(--text-muted)", fontSize: 12 }}>
                      <span>{elapsed}s elapsed</span>
                      <span style={{ fontWeight: 600, color: "var(--primary)" }}>{p.percent.toFixed(1)}%</span>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div style={{ height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", borderRadius: 4,
                      width: `${Math.max(p.percent, 1)}%`,
                      background: "linear-gradient(90deg, var(--primary), var(--primary-hover, #818cf8))",
                      transition: "width .4s ease",
                    }} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                    Snapshot: {p.snapshotId.slice(0, 12)}…
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Recent Snapshots */}
        <div className="card">
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Recent Backups</h2>
          {snapshots.length === 0 ? (
            <div className="empty-state"><p>No backups yet</p></div>
          ) : (
            <table>
              <thead>
                <tr><th>Job</th><th>Status</th><th>Size</th><th>Started</th></tr>
              </thead>
              <tbody>
                {snapshots.slice(0, 10).map((s) => {
                  const job = jobs.find((j) => j.id === s.jobId);
                  return (
                    <tr key={s.id}>
                      <td style={{ fontSize: 12, fontWeight: 500 }}>{job?.name ?? s.jobId.slice(0, 8)}</td>
                      <td><StatusBadge status={s.status} /></td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {s.sizeBytes ? fmtSize(s.sizeBytes) : "—"}
                      </td>
                      <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{fmt(s.startedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Agent Status */}
          <div className="card">
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Agent Status</h2>
            {agents.length === 0 ? (
              <div className="empty-state"><Server size={32} /><p>No agents registered</p></div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {agents.map((a) => {
                  const agentProgress = Object.values(runningJobs).find((p) => p.agentId === a.id);
                  return (
                    <div key={a.id} style={{ padding: "10px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div>
                          <div style={{ fontWeight: 500 }}>{a.name}</div>
                          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{a.hostname} · {a.os}/{a.arch}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <StatusBadge status={agentProgress ? "running" : (a.status === "busy" ? "running" : a.status as string)} />
                          <button className="btn-ghost" style={{ padding: "3px 6px" }}
                            onClick={() => { if (confirm(`Delete agent "${a.name}"?`)) deleteMut.mutate(a.id); }}>
                            <Trash2 size={13} color="var(--danger)" />
                          </button>
                        </div>
                      </div>
                      {/* Inline mini progress bar for busy agents */}
                      {agentProgress && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                            <div style={{
                              height: "100%", borderRadius: 2,
                              width: `${Math.max(agentProgress.percent, 1)}%`,
                              background: "var(--primary)", transition: "width .4s ease",
                            }} />
                          </div>
                          <div style={{ fontSize: 11, color: "var(--primary)", marginTop: 3 }}>
                            Backing up… {agentProgress.percent.toFixed(0)}%
                            {agentProgress.sizeTotal > 0 && ` · ${fmtSize(agentProgress.sizeDone)} / ${fmtSize(agentProgress.sizeTotal)}`}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Live Activity */}
          {activity.length > 0 && (
            <div className="card">
              <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <Activity size={14} /> Recent Events
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {activity.map((e, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "5px 8px", background: "var(--bg)", borderRadius: 5 }}>
                    {e.type === "snapshot_done" ? (
                      e.status === "success"
                        ? <CheckCircle size={12} color="var(--success)" />
                        : <XCircle size={12} color="var(--danger)" />
                    ) : e.type === "check_passed" ? (
                      <ShieldCheck size={12} color="var(--success)" />
                    ) : e.type === "check_failed" ? (
                      <ShieldAlert size={12} color="var(--danger)" />
                    ) : (
                      <HardDrive size={12} color="var(--text-muted)" />
                    )}
                    <span style={{ color: "var(--text)" }}>
                      {e.type === "snapshot_done" ? `Backup ${e.status}`
                        : e.type === "check_passed" ? "Integrity check passed"
                        : e.type === "check_failed" ? "Integrity check FAILED"
                        : `Agent ${e.status}`}
                    </span>
                    <span style={{ color: "var(--text-muted)", marginLeft: "auto" }}>{fmtRelative(e.ts)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: React.ReactNode; label: string }> = {
    online:    { cls: "badge-success", icon: <CheckCircle size={11} />, label: "Online" },
    offline:   { cls: "badge-muted",   icon: <XCircle size={11} />,    label: "Offline" },
    busy:      { cls: "badge-primary", icon: <Clock size={11} />,      label: "Busy" },
    success:   { cls: "badge-success", icon: <CheckCircle size={11} />, label: "Success" },
    failed:    { cls: "badge-danger",  icon: <XCircle size={11} />,    label: "Failed" },
    running:   { cls: "badge-primary", icon: <Clock size={11} />,      label: "Running" },
    cancelled: { cls: "badge-muted",   icon: <XCircle size={11} />,    label: "Cancelled" },
  };
  const s = map[status] ?? { cls: "badge-muted", icon: null, label: status };
  return <span className={`badge ${s.cls}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{s.icon}{s.label}</span>;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.toDateString() === n.toDateString();
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtRelative(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function fmtSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
