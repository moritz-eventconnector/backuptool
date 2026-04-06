import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AuditLogEntry } from "../api/client.ts";
import { ClipboardList } from "lucide-react";

const ACTION_COLORS: Record<string, string> = {
  login: "badge-primary",
  logout: "badge-muted",
  create_job: "badge-success",
  update_job: "badge-primary",
  delete_job: "badge-danger",
  run_job: "badge-primary",
  verify_backup: "badge-primary",
  rotate_key: "badge-warning",
  restore_snapshot: "badge-primary",
  delete_snapshot: "badge-danger",
  create_destination: "badge-success",
  update_destination: "badge-primary",
  delete_destination: "badge-danger",
  reset_destination_repo: "badge-warning",
};

export default function AuditLog() {
  const [actionFilter, setActionFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");

  const { data: entries = [], isLoading } = useQuery<AuditLogEntry[]>({
    queryKey: ["audit-logs", actionFilter, userFilter],
    queryFn: () => api.getAuditLogs({ action: actionFilter, user: userFilter }),
    refetchInterval: 30_000,
  });

  return (
    <div>
      <div className="page-header">
        <h1>Audit Log</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Filter by user…"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            style={{ width: 180, padding: "6px 10px", fontSize: 13 }}
          />
          <input
            placeholder="Filter by action…"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            style={{ width: 180, padding: "6px 10px", fontSize: 13 }}
          />
        </div>
      </div>

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : entries.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <ClipboardList size={40} />
            <p style={{ marginTop: 8 }}>No audit log entries</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Resource</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {new Date(e.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </td>
                  <td style={{ fontSize: 13 }}>{e.userEmail ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                  <td>
                    <span className={`badge ${ACTION_COLORS[e.action] ?? "badge-muted"}`} style={{ fontSize: 11 }}>
                      {e.action.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "monospace" }}>
                    {e.resource ?? "—"}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {e.ip ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
