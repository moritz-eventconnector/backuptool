import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { useEffect, useRef, useState } from "react";
import { config } from "../config.ts";
import { CheckCircle, XCircle, Clock, Server, Activity } from "lucide-react";

interface LiveEvent {
  type: string;
  agentId?: string;
  snapshotId?: string;
  status?: string;
  percent?: number;
  message?: string;
  level?: string;
}

export default function Dashboard() {
  const { data: agents = [] } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const { data: snapshots = [] } = useQuery({ queryKey: ["snapshots"], queryFn: () => api.listSnapshots(50) });
  const { data: jobs = [] } = useQuery({ queryKey: ["jobs"], queryFn: api.listJobs });
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(config.wsUrl);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "ui_connect" }));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as LiveEvent;
        if (["agent_status", "progress", "snapshot_done"].includes(msg.type)) {
          setLiveEvents((prev) => [msg, ...prev].slice(0, 20));
        }
      } catch { /**/ }
    };
    return () => ws.close();
  }, []);

  const online = agents.filter((a) => a.status === "online" || a.status === "busy").length;
  const successToday = snapshots.filter((s) => s.status === "success" && isToday(s.startedAt)).length;
  const failedToday = snapshots.filter((s) => s.status === "failed" && isToday(s.startedAt)).length;
  const running = snapshots.filter((s) => s.status === "running").length;

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
      </div>

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
          <div className="value" style={{ color: "var(--primary)" }}>{running}</div>
        </div>
        <div className="stat-card">
          <div className="label">Active Jobs</div>
          <div className="value">{jobs.filter((j) => j.enabled).length}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Recent Snapshots */}
        <div className="card">
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Recent Backups</h2>
          {snapshots.length === 0 ? (
            <div className="empty-state"><p>No backups yet</p></div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.slice(0, 10).map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-muted)" }}>{s.jobId.slice(0, 8)}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{fmt(s.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Agent Status */}
        <div className="card">
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Agent Status</h2>
          {agents.length === 0 ? (
            <div className="empty-state">
              <Server size={32} />
              <p>No agents registered</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {agents.map((a) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{a.hostname} · {a.os}/{a.arch}</div>
                  </div>
                  <StatusBadge status={a.status === "busy" ? "running" : a.status as "online" | "offline"} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Live Activity Feed */}
      {liveEvents.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <Activity size={15} /> Live Activity
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {liveEvents.map((e, i) => (
              <div key={i} style={{ fontSize: 13, color: "var(--text-muted)", padding: "6px 10px", background: "var(--bg)", borderRadius: 6 }}>
                <span style={{ color: "var(--text)" }}>{e.type}</span>
                {e.agentId && ` · agent:${e.agentId.slice(0, 8)}`}
                {e.status && ` · ${e.status}`}
                {e.message && ` · ${e.message}`}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: React.ReactNode; label: string }> = {
    online:  { cls: "badge-success", icon: <CheckCircle size={11} />, label: "Online" },
    offline: { cls: "badge-muted",   icon: <XCircle size={11} />,     label: "Offline" },
    busy:    { cls: "badge-primary", icon: <Clock size={11} />,       label: "Busy" },
    success: { cls: "badge-success", icon: <CheckCircle size={11} />, label: "Success" },
    failed:  { cls: "badge-danger",  icon: <XCircle size={11} />,     label: "Failed" },
    running: { cls: "badge-primary", icon: <Clock size={11} />,       label: "Running" },
    cancelled: { cls: "badge-muted", icon: <XCircle size={11} />,     label: "Cancelled" },
  };
  const s = map[status] ?? { cls: "badge-muted", icon: null, label: status };
  return <span className={`badge ${s.cls}`}>{s.icon}{s.label}</span>;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.toDateString() === n.toDateString();
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
