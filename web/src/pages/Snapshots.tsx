import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Snapshot, type SnapshotLog, type RestoreAgent, type RestoreDestination } from "../api/client.ts";
import { Camera, ChevronDown, ChevronUp, Trash2, RotateCcw, Lock, Square, CheckSquare, Download } from "lucide-react";
import { useWsEvent } from "../context/WebSocketContext.tsx";

// Live backup progress received via WebSocket: keyed by snapshotId
type BackupProgress = { percent: number; filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number };

export default function Snapshots() {
  const qc = useQueryClient();
  const { data: snapshots = [], isLoading } = useQuery({ queryKey: ["snapshots"], queryFn: () => api.listSnapshots(200) });
  const { data: agents = [] } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const { data: jobs = [] } = useQuery({ queryKey: ["jobs"], queryFn: api.listJobs });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [restoreDialog, setRestoreDialog] = useState<{ snapshotId: string; jobId: string } | null>(null);
  const [restorePath, setRestorePath] = useState("");
  const [restoreMode, setRestoreMode] = useState<"original" | "custom">("original");
  const [restoreMsg, setRestoreMsg] = useState("");
  const [restoreRunning, setRestoreRunning] = useState(false);
  const [restorePercent, setRestorePercent] = useState<number | null>(null);
  const [restoreFilesDone, setRestoreFilesDone] = useState<number | null>(null);
  const [restoreFilesTotal, setRestoreFilesTotal] = useState<number | null>(null);
  const [targetAgentId, setTargetAgentId] = useState<string>("");
  const [targetDestinationId, setTargetDestinationId] = useState<string>("");
  // Partial restore: checked source paths + optional custom patterns
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [customInclude, setCustomInclude] = useState("");
  const [backupProgress, setBackupProgress] = useState<Record<string, BackupProgress>>({});

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLockDays, setBulkLockDays] = useState("30");
  const [bulkMsg, setBulkMsg] = useState("");

  // WebSocket events via global connection
  useWsEvent(["restore_result", "restore_progress", "progress", "snapshot_done", "check_result"] as const, (msg) => {
    if (msg.type === "restore_result") {
      setRestoreRunning(false);
      setRestorePercent(null);
      if (msg.status === "success") {
        setRestoreMsg(`Restore completed successfully. Files are at: ${msg.restorePath}`);
      } else {
        setRestoreMsg(`Restore failed: ${msg.errorMessage ?? "unknown error"}`);
      }
      qc.invalidateQueries({ queryKey: ["snapshot-logs", msg.snapshotId as string] });
    } else if (msg.type === "restore_progress") {
      setRestorePercent((msg.percent as number) ?? null);
      if (msg.filesDone != null) setRestoreFilesDone(msg.filesDone as number);
      if (msg.filesTotal != null) setRestoreFilesTotal(msg.filesTotal as number);
    } else if (msg.type === "progress") {
      const sid = msg.snapshotId as string;
      if (sid) {
        setBackupProgress((prev) => ({
          ...prev,
          [sid]: {
            percent: (msg.percent as number) ?? 0,
            filesDone: (msg.filesDone as number) ?? 0,
            filesTotal: (msg.filesTotal as number) ?? 0,
            bytesDone: (msg.bytesDone as number) ?? 0,
            bytesTotal: (msg.bytesTotal as number) ?? 0,
          },
        }));
      }
    } else if (msg.type === "snapshot_done" || msg.type === "check_result") {
      qc.invalidateQueries({ queryKey: ["snapshots"] });
      if (msg.snapshotId) {
        setBackupProgress((prev) => {
          const next = { ...prev };
          delete next[msg.snapshotId as string];
          return next;
        });
      }
    }
  });

  const deleteMut = useMutation({ mutationFn: api.deleteSnapshot, onSuccess: () => qc.invalidateQueries({ queryKey: ["snapshots"] }) });
  const restoreMut = useMutation({
    mutationFn: ({ id, path, agentId, includePaths, destinationId }: { id: string; path: string; agentId?: string; includePaths?: string[]; destinationId?: string }) =>
      api.restoreSnapshot(id, path, agentId || undefined, includePaths?.length ? includePaths : undefined, destinationId || undefined),
    onSuccess: () => {
      setRestoreRunning(true);
      setRestorePercent(null);
      setRestoreMsg("Restore running on agent — this may take a few minutes…");
    },
    onError: (e: Error) => { setRestoreMsg(`Error: ${e.message}`); },
  });

  const bulkDeleteMut = useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteSnapshots(ids),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["snapshots"] });
      setSelectedIds(new Set());
      const msg = `Deleted ${data.deleted} snapshot${data.deleted !== 1 ? "s" : ""}`;
      setBulkMsg(data.skipped > 0 ? `${msg}. ${data.skipped} skipped (locked).` : msg + ".");
    },
    onError: (e: Error) => setBulkMsg(`Error: ${e.message}`),
  });

  const bulkLockMut = useMutation({
    mutationFn: ({ ids, days }: { ids: string[]; days: number }) => api.bulkLockSnapshots(ids, days),
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ["snapshots"] });
      setSelectedIds(new Set());
      setBulkMsg(`Locked ${data.locked} snapshot${data.locked !== 1 ? "s" : ""} until ${new Date(data.lockedUntil).toLocaleDateString()} (${vars.days} days).`);
    },
    onError: (e: Error) => setBulkMsg(`Error: ${e.message}`),
  });

  const filtered = statusFilter === "all" ? snapshots : snapshots.filter((s) => s.status === statusFilter);

  const allFilteredIds = filtered.map((s) => s.id);
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  function toggleAll() {
    if (allSelected) {
      setSelectedIds((prev) => { const next = new Set(prev); allFilteredIds.forEach((id) => next.delete(id)); return next; });
    } else {
      setSelectedIds((prev) => new Set([...prev, ...allFilteredIds]));
    }
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  return (
    <div>
      <div className="page-header">
        <h1>Snapshots</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {["all", "success", "warning", "failed", "running", "orphaned"].map((s) => (
            <button key={s} className={statusFilter === s ? "btn-primary" : "btn-ghost"} style={{ padding: "6px 14px", textTransform: "capitalize" }}
              onClick={() => { setStatusFilter(s); setSelectedIds(new Set()); setBulkMsg(""); }}>{s}</button>
          ))}
          <button
            className="btn-ghost"
            style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--border)", marginLeft: 4 }}
            onClick={() => api.exportSnapshots({ status: statusFilter !== "all" ? statusFilter : undefined })}
            title="Export as CSV"
          >
            <Download size={14} /> CSV
          </button>
        </div>
      </div>

      {/* Bulk action toolbar — shown when at least one snapshot is selected */}
      {someSelected && (
        <div className="card" style={{ marginBottom: 12, padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "var(--bg-secondary)", borderLeft: "3px solid var(--primary)" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{selectedIds.size} selected</span>
          <button className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px", color: "var(--text-muted)" }}
            onClick={() => setSelectedIds(new Set())}>Deselect all</button>
          <div style={{ flex: 1 }} />
          {bulkMsg && <span style={{ fontSize: 12, color: bulkMsg.startsWith("Error") ? "var(--danger)" : "var(--success, #22c55e)" }}>{bulkMsg}</span>}
          {/* Lock section */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Lock size={13} color="var(--warning, #f59e0b)" />
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Lock for</span>
            <input
              type="number" min={1} max={36500} value={bulkLockDays}
              onChange={(e) => setBulkLockDays(e.target.value)}
              style={{ width: 60, padding: "3px 6px", fontSize: 12 }}
            />
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>days</span>
            <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12, color: "var(--warning, #f59e0b)", border: "1px solid var(--warning, #f59e0b)" }}
              disabled={bulkLockMut.isPending}
              onClick={() => {
                const days = parseInt(bulkLockDays, 10);
                if (!days || days < 1) { setBulkMsg("Enter a valid number of days."); return; }
                if (!confirm(`Lock ${selectedIds.size} snapshot(s) for ${days} days? They cannot be deleted until the lock expires.`)) return;
                setBulkMsg("");
                bulkLockMut.mutate({ ids: [...selectedIds], days });
              }}>
              {bulkLockMut.isPending ? "Locking…" : "Lock"}
            </button>
          </div>
          {/* Delete section */}
          <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12, color: "var(--danger)", border: "1px solid var(--danger)" }}
            disabled={bulkDeleteMut.isPending}
            onClick={() => {
              if (!confirm(`Delete ${selectedIds.size} snapshot(s)? Locked snapshots will be skipped.`)) return;
              setBulkMsg("");
              bulkDeleteMut.mutate([...selectedIds]);
            }}>
            {bulkDeleteMut.isPending ? <><span className="spinner" style={{ width: 11, height: 11, marginRight: 5 }} />Deleting…</> : <><Trash2 size={12} style={{ marginRight: 5 }} />Delete</>}
          </button>
        </div>
      )}

      {/* Restore Dialog */}
      {restoreDialog && (() => {
        const dialogJob = jobs.find((j) => j.id === restoreDialog.jobId);
        const sourcePaths: string[] = dialogJob?.sourcePaths ?? [];
        const effectivePath = restoreMode === "original" ? "/" : restorePath;

        // Build includePaths: checked source paths + custom patterns
        const customLines = customInclude.split("\n").map((l) => l.trim()).filter(Boolean);
        const includePaths = selectedPaths.length < sourcePaths.length || customLines.length
          ? [...selectedPaths, ...customLines]
          : []; // empty = restore everything

        const allChecked = selectedPaths.length === sourcePaths.length;

        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
            <div className="card" style={{ width: 520, background: "var(--bg-secondary)", maxHeight: "90vh", overflowY: "auto" }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Restore Snapshot</h3>
              {restoreMsg && <div className={`alert ${restoreMsg.startsWith("Error") || restoreMsg.startsWith("Restore failed") ? "alert-error" : "alert-success"}`} style={{ marginBottom: 10 }}>{restoreMsg}</div>}

              {/* Path selection */}
              {sourcePaths.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>WHAT TO RESTORE</div>
                    <button className="btn-ghost" style={{ fontSize: 11, padding: "2px 6px" }}
                      onClick={() => setSelectedPaths(allChecked ? [] : [...sourcePaths])}>
                      {allChecked ? "Deselect all" : "Select all"}
                    </button>
                  </div>
                  <div style={{ background: "var(--bg)", borderRadius: "var(--radius)", padding: "4px 8px", maxHeight: 220, overflowY: "auto" }}>
                    {sourcePaths.map((p) => (
                      <label key={p} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 4px", cursor: "pointer", width: "100%", boxSizing: "border-box" }}>
                        <input type="checkbox"
                          style={{ flexShrink: 0, width: 15, height: 15, cursor: "pointer", accentColor: "var(--primary)" }}
                          checked={selectedPaths.includes(p)}
                          onChange={(e) => setSelectedPaths((prev) =>
                            e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)
                          )} />
                        <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{p}</span>
                      </label>
                    ))}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Additional paths / patterns (one per line, optional)</div>
                    <textarea
                      value={customInclude}
                      onChange={(e) => setCustomInclude(e.target.value)}
                      placeholder={"/etc/nginx/nginx.conf\n/var/www/html"}
                      rows={2}
                      style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
                    />
                  </div>
                  {includePaths.length === 0 ? (
                    <div style={{ fontSize: 11, color: "var(--success, #22c55e)", marginTop: 4 }}>All files will be restored.</div>
                  ) : (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                      Only restoring: {includePaths.map((p) => <code key={p} style={{ marginRight: 4 }}>{p}</code>)}
                    </div>
                  )}
                </div>
              )}

              {/* Destination selector — shown when job has multiple destinations */}
              <DestinationSelector snapshotId={restoreDialog.snapshotId} value={targetDestinationId} onChange={setTargetDestinationId} />

              {/* Agent selector for cross-agent restore */}
              <AgentSelector snapshotId={restoreDialog.snapshotId} value={targetAgentId} onChange={setTargetAgentId} />

              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <button
                  className={restoreMode === "original" ? "btn-primary" : "btn-ghost"}
                  style={{ flex: 1, fontSize: 13 }}
                  onClick={() => setRestoreMode("original")}
                >
                  Restore to original location
                </button>
                <button
                  className={restoreMode === "custom" ? "btn-primary" : "btn-ghost"}
                  style={{ flex: 1, fontSize: 13 }}
                  onClick={() => setRestoreMode("custom")}
                >
                  Restore to custom path
                </button>
              </div>

              {restoreMode === "original" ? (
                <div style={{ background: "var(--bg)", borderRadius: "var(--radius)", padding: "10px 12px", fontSize: 13, color: "var(--text-muted)", marginBottom: 14 }}>
                  Files will be restored to their <strong style={{ color: "var(--warning, #f59e0b)" }}>original paths</strong> on the agent host. Existing files may be overwritten.
                </div>
              ) : (
                <div className="form-group" style={{ marginBottom: 6 }}>
                  <label>Restore to directory</label>
                  <input value={restorePath} onChange={(e) => setRestorePath(e.target.value)} placeholder="/tmp/restore" autoFocus />
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    restic preserves the full path structure inside this directory.
                    E.g. <code>/etc/bind/named.conf</code> → <code>{restorePath || "/tmp/restore"}/etc/bind/named.conf</code>
                  </div>
                </div>
              )}

              {/* Restore progress bar */}
              {restoreRunning && restorePercent != null && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
                    <span>Restoring…</span>
                    <span>{restorePercent.toFixed(1)}%{restoreFilesTotal ? ` — ${restoreFilesDone}/${restoreFilesTotal} files` : ""}</span>
                  </div>
                  <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${restorePercent}%`, background: "var(--primary)", transition: "width .3s ease" }} />
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button className="btn-primary"
                  disabled={(restoreMode === "custom" && !restorePath) || restoreMut.isPending || restoreRunning}
                  onClick={() => { setRestoreMsg(""); restoreMut.mutate({ id: restoreDialog.snapshotId, path: effectivePath, agentId: targetAgentId, includePaths, destinationId: targetDestinationId }); }}>
                  {restoreRunning ? <><span className="spinner" style={{ width: 12, height: 12, marginRight: 6 }} />Restoring…</> : "Restore"}
                </button>
                <button className="btn-ghost"
                  onClick={() => { setRestoreDialog(null); setRestorePath(""); setRestoreMsg(""); setRestoreMode("original"); setRestoreRunning(false); setRestorePercent(null); setTargetAgentId(""); setTargetDestinationId(""); setSelectedPaths([]); setCustomInclude(""); }}>
                  {restoreRunning ? "Close" : "Cancel"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><Camera size={40} /><p style={{ marginTop: 8 }}>No snapshots found</p></div></div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th style={{ width: 36, padding: "8px 4px 8px 12px" }}>
                  <button className="btn-ghost" style={{ padding: 2 }} title={allSelected ? "Deselect all" : "Select all"} onClick={toggleAll}>
                    {allSelected ? <CheckSquare size={14} color="var(--primary)" /> : <Square size={14} color="var(--text-muted)" />}
                  </button>
                </th>
                <th>Started</th><th>Job</th><th>Agent</th><th>Status</th><th>Size</th><th>Duration</th><th>Retries</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const job = jobs.find((j) => j.id === s.jobId);
                const agent = agents.find((a) => a.id === s.agentId);
                const prog = backupProgress[s.id];
                const isSelected = selectedIds.has(s.id);

                // Lock state: job-level WORM or per-snapshot lock
                const wormLocked = (() => {
                  if (job?.wormEnabled && job.wormRetentionDays) {
                    const unlockMs = new Date(s.startedAt).getTime() + job.wormRetentionDays * 86_400_000;
                    if (Date.now() < unlockMs) return new Date(unlockMs);
                  }
                  return null;
                })();
                const snapLocked = s.lockedUntil && new Date(s.lockedUntil) > new Date() ? new Date(s.lockedUntil) : null;
                const locked = wormLocked ?? snapLocked;

                return (
                  <>
                    <tr key={s.id} style={{ cursor: "pointer", background: isSelected ? "rgba(var(--primary-rgb, 99,102,241),.07)" : undefined }}
                      onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                      <td style={{ padding: "8px 4px 8px 12px" }} onClick={(e) => { e.stopPropagation(); toggleOne(s.id); }}>
                        <button className="btn-ghost" style={{ padding: 2 }}>
                          {isSelected ? <CheckSquare size={14} color="var(--primary)" /> : <Square size={14} color="var(--text-muted)" />}
                        </button>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{fmt(s.startedAt)}</td>
                      <td style={{ fontWeight: 500 }}>
                        {job?.name ?? s.jobId.slice(0, 8)}
                        {job?.wormEnabled && (
                          <span title={wormLocked ? `WORM locked until ${wormLocked.toLocaleDateString()}` : "WORM (unlocked)"} style={{ marginLeft: 6, display: "inline-flex", verticalAlign: "middle" }}>
                            <Lock size={11} color={wormLocked ? "var(--warning, #f59e0b)" : "var(--text-muted)"} />
                          </span>
                        )}
                        {snapLocked && !wormLocked && (
                          <span title={`Individually locked until ${snapLocked.toLocaleDateString()}`} style={{ marginLeft: 6, display: "inline-flex", verticalAlign: "middle" }}>
                            <Lock size={11} color="var(--primary)" />
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
                          {(s.status === "success" || s.status === "warning") && (
                            <button className="btn-ghost" style={{ padding: "3px 6px" }} title="Restore"
                              onClick={(e) => {
                                e.stopPropagation();
                                const jobForSnap = jobs.find((j) => j.id === s.jobId);
                                setSelectedPaths(jobForSnap?.sourcePaths ?? []);
                                setCustomInclude("");
                                setRestoreDialog({ snapshotId: s.id, jobId: s.jobId });
                                setRestorePath(""); setRestoreMsg(""); setRestoreMode("original"); setTargetAgentId("");
                              }}>
                              <RotateCcw size={12} color="var(--primary)" />
                            </button>
                          )}
                          {locked ? (
                            <span title={`Locked until ${locked.toLocaleDateString()} — deletion not permitted`}
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
                    {/* Live backup progress bar */}
                    {s.status === "running" && prog && (
                      <tr key={`${s.id}-progress`}>
                        <td colSpan={9} style={{ padding: "0 16px 8px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
                            <span>Backing up…</span>
                            <span>
                              {prog.percent.toFixed(1)}%
                              {prog.filesTotal > 0 ? ` — ${prog.filesDone}/${prog.filesTotal} files` : ""}
                              {prog.bytesTotal > 0 ? ` — ${fmtSize(prog.bytesDone)} / ${fmtSize(prog.bytesTotal)}` : ""}
                            </span>
                          </div>
                          <div style={{ height: 4, background: "var(--bg)", borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${prog.percent}%`, background: "var(--primary)", transition: "width .5s ease" }} />
                          </div>
                        </td>
                      </tr>
                    )}
                    {expanded === s.id && (
                      <tr key={`${s.id}-detail`}>
                        <td colSpan={9} style={{ padding: 0 }}>
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

function DestinationSelector({ snapshotId, value, onChange }: { snapshotId: string; value: string; onChange: (id: string) => void }) {
  const { data: dests = [] } = useQuery<RestoreDestination[]>({
    queryKey: ["restore-destinations", snapshotId],
    queryFn: () => api.getRestoreDestinations(snapshotId),
  });

  if (dests.length <= 1) return null;

  const defaultDest = dests.find((d) => d.isDefault);

  return (
    <div className="form-group" style={{ marginBottom: 14 }}>
      <label>Restore from destination</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{defaultDest ? `${defaultDest.name} (${defaultDest.type}) — default` : "Default destination"}</option>
        {dests.filter((d) => !d.isDefault).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({d.type})
          </option>
        ))}
      </select>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
        Choose which storage destination to restore from.
      </div>
    </div>
  );
}

function AgentSelector({ snapshotId, value, onChange }: { snapshotId: string; value: string; onChange: (id: string) => void }) {
  const { data: restoreAgents = [] } = useQuery<RestoreAgent[]>({
    queryKey: ["restore-agents", snapshotId],
    queryFn: () => api.getRestoreAgents(snapshotId),
  });

  if (restoreAgents.length <= 1) return null;

  return (
    <div className="form-group" style={{ marginBottom: 14 }}>
      <label>Restore on agent</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Original agent{restoreAgents.find((a) => a.isOriginal) ? ` (${restoreAgents.find((a) => a.isOriginal)!.name})` : ""}</option>
        {restoreAgents.map((a) => (
          <option key={a.id} value={a.id} disabled={!a.online}>
            {a.name} ({a.hostname}){a.isOriginal ? " — original" : ""}{!a.online ? " — offline" : ""}
          </option>
        ))}
      </select>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
        Use a different agent for disaster recovery (e.g. original server is gone).
      </div>
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
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Integrity check</div>
          <div style={{ fontSize: 12, color: snapshot.integrityCheckStatus === "failed" ? "var(--danger)" : snapshot.integrityCheckStatus === "passed" ? "var(--success, #22c55e)" : "var(--text-muted)" }}>
            {snapshot.integrityCheckStatus ?? "—"}
          </div>
        </div>
      </div>
      {snapshot.lockedUntil && new Date(snapshot.lockedUntil) > new Date() && (
        <div style={{ fontSize: 12, color: "var(--primary)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <Lock size={12} />
          Individually locked until {new Date(snapshot.lockedUntil).toLocaleDateString()}
        </div>
      )}
      {snapshot.errorMessage && (
        <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 8 }}>{snapshot.errorMessage}</div>
      )}
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
  const map: Record<string, string> = {
    success: "badge-success",
    failed: "badge-danger",
    running: "badge-primary",
    cancelled: "badge-muted",
    warning: "badge-warning",
    orphaned: "badge-muted",
  };
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
