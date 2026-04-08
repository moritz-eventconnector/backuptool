import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Job, type DiscoveredService } from "../api/client.ts";
import { Plus, Trash2, Play, Pencil, Briefcase, Lock, Sparkles, X, ChevronDown, ChevronUp, ShieldCheck, KeyRound, RefreshCw } from "lucide-react";
import { CronPicker } from "../components/CronPicker.tsx";
import { useWsEvent } from "../context/WebSocketContext.tsx";

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

  // Per-job inline status messages for verify / rotate-key
  const [jobMsg, setJobMsg] = useState<Record<string, { text: string; ok: boolean }>>({});
  const setMsg = (id: string, text: string, ok: boolean) => setJobMsg((p) => ({ ...p, [id]: { text, ok } }));

  const verifyMut = useMutation({
    mutationFn: api.verifyJob,
    onSuccess: (_, id) => setMsg(id, "Deep verification started on agent…", true),
    onError: (e: Error, id) => setMsg(id, `Error: ${e.message}`, false),
  });
  const rotateMut = useMutation({
    mutationFn: api.rotateJobKey,
    onSuccess: (_, id) => setMsg(id, "Key rotation started — agent is re-keying all destinations…", true),
    onError: (e: Error, id) => setMsg(id, `Error: ${e.message}`, false),
  });
  const resetRepoMut = useMutation({
    mutationFn: api.resetJobRepo,
    onSuccess: (_, id) => {
      setMsg(id, "Repo path reset. Existing snapshots orphaned. A fresh isolated repo will be created on the next backup.", true);
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["snapshots"] });
    },
    onError: (e: Error, id) => setMsg(id, `Error: ${e.message}`, false),
  });

  // Listen for verify/rotate results via global WS
  useWsEvent(["verify_result", "rotate_key_result", "snapshot_done"] as const, (msg) => {
    if (msg.type === "verify_result") {
      const ok = msg.status === "passed";
      setMsg(msg.jobId as string, ok ? "Verification passed — data intact." : `Verification FAILED: ${msg.message}`, ok);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } else if (msg.type === "rotate_key_result") {
      const ok = msg.status === "success";
      setMsg(msg.jobId as string, ok ? "Key rotation complete — new password active." : `Key rotation failed: ${msg.message ?? "unknown"}`, ok);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } else if (msg.type === "snapshot_done") {
      qc.invalidateQueries({ queryKey: ["snapshots"] });
    }
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
              <tr><th>Name</th><th>Agent</th><th>Schedule</th><th>Status</th><th>Last verified</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const agent = agents.find((a) => a.id === j.agentId);
                const msg = jobMsg[j.id];
                return (
                  <>
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
                      <td style={{ fontSize: 12 }}>
                        {j.lastVerifiedAt ? (
                          <span style={{ color: j.lastVerifyStatus === "passed" ? "var(--success, #22c55e)" : j.lastVerifyStatus === "failed" ? "var(--danger)" : "var(--text-muted)" }}>
                            {j.lastVerifyStatus === "passed" ? "✓" : j.lastVerifyStatus === "failed" ? "✗" : ""}{" "}
                            {new Date(j.lastVerifiedAt).toLocaleDateString()}
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>Never</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button className="btn-ghost" style={{ padding: "4px 8px" }} title="Run now"
                            onClick={() => runMut.mutate(j.id)} disabled={runMut.isPending}>
                            <Play size={13} color="var(--success)" />
                          </button>
                          <button className="btn-ghost" style={{ padding: "4px 8px" }}
                            title="Deep verify — checks 25% of stored data packs for corruption"
                            onClick={() => { setMsg(j.id, "", true); verifyMut.mutate(j.id); }}
                            disabled={verifyMut.isPending}>
                            <ShieldCheck size={13} color="var(--primary)" />
                          </button>
                          <button className="btn-ghost" style={{ padding: "4px 8px" }}
                            title="Rotate encryption key — generates a new repository password"
                            onClick={() => {
                              if (confirm(`Rotate encryption key for "${j.name}"?\n\nA new restic password will be generated and added to all destinations. The old password is removed after confirmation from the agent.`)) {
                                setMsg(j.id, "", true);
                                rotateMut.mutate(j.id);
                              }
                            }}
                            disabled={rotateMut.isPending}>
                            <KeyRound size={13} color="var(--warning, #f59e0b)" />
                          </button>
                          <button className="btn-ghost" style={{ padding: "4px 8px" }}
                            title="Reset repo path — assigns a new unique sub-path on the destination, fixing password conflicts when multiple jobs share a destination. Orphans existing snapshots."
                            onClick={() => {
                              if (confirm(`Reset repository path for "${j.name}"?\n\nThis assigns a new unique path on the destination bucket so this job no longer conflicts with others sharing the same destination.\n\nExisting snapshots will be marked orphaned and a fresh repository will be initialised on the next backup.`)) {
                                setMsg(j.id, "", true);
                                resetRepoMut.mutate(j.id);
                              }
                            }}
                            disabled={resetRepoMut.isPending}>
                            <RefreshCw size={13} color="var(--text-muted)" />
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
                    {msg?.text && (
                      <tr key={`${j.id}-msg`}>
                        <td colSpan={6} style={{ padding: "3px 12px 8px", fontSize: 12, color: msg.ok ? "var(--success, #22c55e)" : "var(--danger)" }}>
                          {msg.text}
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
  const { data: discoveredServices = [] } = useQuery({
    queryKey: ["discovered", agentId],
    queryFn: () => api.getDiscoveredServices(agentId),
    enabled: !!agentId && !job,
  });
  // Discovery multi-select
  const [selectedSvcs, setSelectedSvcs] = useState<DiscoveredService[]>([]);
  const [svcFilter, setSvcFilter] = useState<string>("all");
  const [showAllSvcs, setShowAllSvcs] = useState(false);
  const [extraPaths, setExtraPaths] = useState((job?.sourcePaths ?? []).join("\n"));
  const [sourceType, setSourceType] = useState<"local" | "s3">(job?.sourceType ?? "local");
  const [s3Endpoint, setS3Endpoint] = useState(job?.sourceConfig?.endpoint ?? "");
  const [s3Bucket, setS3Bucket] = useState(job?.sourceConfig?.bucket ?? "");
  const [s3Path, setS3Path] = useState(job?.sourceConfig?.path ?? "");
  const [s3AccessKey, setS3AccessKey] = useState(job?.sourceConfig?.accessKeyId ?? "");
  const [s3SecretKey, setS3SecretKey] = useState("");  // never pre-filled for security
  const [s3Region, setS3Region] = useState(job?.sourceConfig?.region ?? "");

  // Combine paths from selected services + manually added paths (deduplicated)
  const combinedPaths = useMemo(() => {
    const fromSvcs = selectedSvcs.flatMap((s) => (s.sourcePaths ?? []).filter(Boolean));
    const manual = extraPaths.split("\n").map((p) => p.trim()).filter(Boolean);
    return [...new Set([...fromSvcs, ...manual])];
  }, [selectedSvcs, extraPaths]);

  const combinedPreScript = useMemo(() =>
    selectedSvcs.filter((s) => s.preScript).map((s) => `# === ${s.name} ===\n${s.preScript}`).join("\n\n"),
    [selectedSvcs]);

  const combinedPostScript = useMemo(() =>
    selectedSvcs.filter((s) => s.postScript).map((s) => `# === ${s.name} ===\n${s.postScript}`).join("\n\n"),
    [selectedSvcs]);

  const toggleSvc = (svc: DiscoveredService) => {
    setSelectedSvcs((prev) => {
      const isSelected = prev.some((s) => s.name === svc.name);
      const next = isSelected ? prev.filter((s) => s.name !== svc.name) : [...prev, svc];
      if (next.length === 1 && !name) setName(next[0].name);
      return next;
    });
  };

  const svcTypes = useMemo(() => {
    const types = new Set(discoveredServices.map((s) => s.type));
    return ["all", ...Array.from(types)];
  }, [discoveredServices]);

  const visibleSvcs = useMemo(() => {
    const filtered = svcFilter === "all" ? discoveredServices : discoveredServices.filter((s) => s.type === svcFilter);
    return showAllSvcs ? filtered : filtered.slice(0, 12);
  }, [discoveredServices, svcFilter, showAllSvcs]);

  const [destIds, setDestIds] = useState<string[]>(job?.destinationIds ?? []);
  const [schedule, setSchedule] = useState(job?.schedule ?? "");
  const [keepLast, setKeepLast] = useState(job?.retention?.keepLast?.toString() ?? "10");
  const [keepDaily, setKeepDaily] = useState(job?.retention?.keepDaily?.toString() ?? "7");
  const [keepWeekly, setKeepWeekly] = useState(job?.retention?.keepWeekly?.toString() ?? "4");
  const [keepMonthly, setKeepMonthly] = useState(job?.retention?.keepMonthly?.toString() ?? "12");
  const [preScript, setPreScript] = useState(job?.preScript ?? "");
  const [postScript, setPostScript] = useState(job?.postScript ?? "");
  const [excludePatterns, setExcludePatterns] = useState((job?.excludePatterns ?? []).join("\n"));
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
      const effectivePre = selectedSvcs.length > 0 ? combinedPreScript : preScript;
      const effectivePost = selectedSvcs.length > 0 ? combinedPostScript : postScript;
      const data = {
        agentId, name,
        sourceType,
        ...(sourceType === "s3" ? {
          sourcePaths: [],
          sourceConfig: {
            endpoint: s3Endpoint || undefined,
            bucket: s3Bucket,
            path: s3Path || undefined,
            accessKeyId: s3AccessKey,
            ...(s3SecretKey ? { secretAccessKey: s3SecretKey } : (job ? {} : { secretAccessKey: s3SecretKey })),
            region: s3Region || undefined,
          },
        } : {
          sourcePaths: job ? extraPaths.split("\n").map((s) => s.trim()).filter(Boolean) : combinedPaths,
        }),
        destinationIds: destIds,
        schedule: schedule || undefined,
        retention: {
          keepLast: parseInt(keepLast) || undefined,
          keepDaily: parseInt(keepDaily) || undefined,
          keepWeekly: parseInt(keepWeekly) || undefined,
          keepMonthly: parseInt(keepMonthly) || undefined,
        },
        preScript: effectivePre || undefined,
        postScript: effectivePost || undefined,
        excludePatterns: excludePatterns.split("\n").map((s) => s.trim()).filter(Boolean),
        enabled,
        wormEnabled,
        wormRetentionDays: parseInt(wormDays) || 0,
      };
      console.log("[job submit] data:", JSON.stringify({ ...data, preScript: data.preScript?.slice(0, 100), postScript: data.postScript?.slice(0, 100) }, null, 2));
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
            <div className="form-group" style={{ gridColumn: "1/-1" }}>
              <label>Schedule <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: 12 }}>(leave empty for manual-only)</span></label>
              <CronPicker value={schedule} onChange={setSchedule} />
            </div>
            <div className="form-group" style={{ gridColumn: "1/-1" }}>
              <label>Source Type</label>
              <div style={{ display: "flex", gap: 8 }}>
                {(["local", "s3"] as const).map((t) => (
                  <button key={t} type="button"
                    className={sourceType === t ? "btn-primary" : "btn-ghost"}
                    style={{ padding: "6px 16px", fontSize: 13 }}
                    onClick={() => setSourceType(t)}
                  >
                    {t === "local" ? "Local paths" : "S3 bucket"}
                  </button>
                ))}
              </div>
            </div>

            {sourceType === "s3" && (
              <div style={{ gridColumn: "1/-1", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="form-group" style={{ gridColumn: "1/-1" }}>
                  <label>Bucket *</label>
                  <input value={s3Bucket} onChange={(e) => setS3Bucket(e.target.value)} placeholder="my-bucket" />
                </div>
                <div className="form-group">
                  <label>Access Key ID *</label>
                  <input value={s3AccessKey} onChange={(e) => setS3AccessKey(e.target.value)} placeholder="AKIAIOSFODNN7..." />
                </div>
                <div className="form-group">
                  <label>Secret Access Key {job ? "(leave blank to keep)" : "*"}</label>
                  <input type="password" value={s3SecretKey} onChange={(e) => setS3SecretKey(e.target.value)} placeholder="••••••••" />
                </div>
                <div className="form-group">
                  <label>Endpoint (S3-compatible)</label>
                  <input value={s3Endpoint} onChange={(e) => setS3Endpoint(e.target.value)} placeholder="https://s3.example.com" />
                </div>
                <div className="form-group">
                  <label>Region</label>
                  <input value={s3Region} onChange={(e) => setS3Region(e.target.value)} placeholder="us-east-1" />
                </div>
                <div className="form-group">
                  <label>Path / Prefix</label>
                  <input value={s3Path} onChange={(e) => setS3Path(e.target.value)} placeholder="folder/subfolder" />
                </div>
              </div>
            )}

            {sourceType === "local" && !job && discoveredServices.length > 0 && (
              <div style={{ gridColumn: "1/-1" }}>
                {/* Header + type filter */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}>
                    <Sparkles size={13} color="var(--primary)" />
                    <span style={{ color: "var(--primary)", fontWeight: 500 }}>Auto-discovered</span>
                  </div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {svcTypes.map((t) => (
                      <button key={t} type="button"
                        className={svcFilter === t ? "btn-primary" : "btn-ghost"}
                        style={{ fontSize: 11, padding: "2px 8px", textTransform: "capitalize" }}
                        onClick={() => setSvcFilter(t)}>{t}</button>
                    ))}
                  </div>
                  {selectedSvcs.length > 0 && (
                    <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)" }}>
                      {selectedSvcs.length} selected · {combinedPaths.length} paths
                    </span>
                  )}
                </div>

                {/* Service grid */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 5, marginBottom: 8 }}>
                  {visibleSvcs.map((svc) => {
                    const sel = selectedSvcs.some((s) => s.name === svc.name);
                    return (
                      <button key={svc.name} type="button"
                        title={svc.note || (svc.sourcePaths ?? []).join(", ")}
                        onClick={() => toggleSvc(svc)}
                        style={{
                          display: "flex", alignItems: "center", gap: 6, padding: "6px 10px",
                          borderRadius: "var(--radius)", fontSize: 12, textAlign: "left",
                          background: sel ? "var(--primary-subtle, rgba(99,102,241,.15))" : "var(--bg)",
                          border: `1px solid ${sel ? "var(--primary)" : "var(--border)"}`,
                          color: sel ? "var(--primary)" : "var(--text-secondary)",
                          cursor: "pointer", transition: "all .12s",
                        }}>
                        <span style={{
                          width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                          background: svc.priority === "critical" ? "var(--danger)" : svc.priority === "recommended" ? "var(--primary)" : "var(--text-muted)",
                        }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{svc.name}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Show more / less */}
                {(svcFilter === "all" ? discoveredServices : discoveredServices.filter((s) => s.type === svcFilter)).length > 12 && (
                  <button type="button" className="btn-ghost" style={{ fontSize: 12, padding: "2px 8px", marginBottom: 8 }}
                    onClick={() => setShowAllSvcs((v) => !v)}>
                    {showAllSvcs ? <><ChevronUp size={11} /> Show less</> : <><ChevronDown size={11} /> Show all ({discoveredServices.length})</>}
                  </button>
                )}

                {/* Selected chips */}
                {selectedSvcs.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                    {selectedSvcs.map((svc) => (
                      <span key={svc.name} style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        background: "var(--primary-subtle, rgba(99,102,241,.15))",
                        border: "1px solid var(--primary)", borderRadius: "var(--radius)",
                        padding: "2px 8px", fontSize: 12, color: "var(--primary)",
                      }}>
                        {svc.name}
                        <button type="button" onClick={() => toggleSvc(svc)}
                          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", color: "inherit" }}>
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Combined paths preview */}
                {selectedSvcs.length > 0 && (
                  <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 10px", marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 5 }}>PATHS TO BACK UP ({combinedPaths.length})</div>
                    {combinedPaths.map((p) => (
                      <div key={p} style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-secondary)", lineHeight: 1.7 }}>{p}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {sourceType === "local" && (
              <div className="form-group" style={{ gridColumn: "1/-1" }}>
                <label>{selectedSvcs.length > 0 ? "Additional paths (one per line)" : "Source Paths (one per line)"}</label>
                <textarea value={extraPaths} onChange={(e) => setExtraPaths(e.target.value)}
                  rows={selectedSvcs.length > 0 ? 2 : 3}
                  placeholder="/home/user/data&#10;/var/lib/database"
                  required={selectedSvcs.length === 0 && !extraPaths} />
              </div>
            )}
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
                {selectedSvcs.length > 0 && combinedPreScript ? (
                  <textarea value={combinedPreScript} readOnly rows={Math.min(combinedPreScript.split("\n").length + 1, 8)}
                    style={{ opacity: 0.8, fontFamily: "monospace", fontSize: 12 }} />
                ) : (
                  <textarea value={preScript} onChange={(e) => setPreScript(e.target.value)} rows={2} placeholder="#!/bin/bash&#10;pg_dump mydb > /tmp/db.sql" />
                )}
                {selectedSvcs.length > 0 && combinedPreScript && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>Auto-generated from selected services</div>
                )}
              </div>
              <div className="form-group">
                <label>Post-backup Script</label>
                {selectedSvcs.length > 0 && combinedPostScript ? (
                  <textarea value={combinedPostScript} readOnly rows={Math.min(combinedPostScript.split("\n").length + 1, 6)}
                    style={{ opacity: 0.8, fontFamily: "monospace", fontSize: 12 }} />
                ) : (
                  <textarea value={postScript} onChange={(e) => setPostScript(e.target.value)} rows={2} placeholder="#!/bin/bash&#10;rm /tmp/db.sql" />
                )}
                {selectedSvcs.length > 0 && combinedPostScript && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>Auto-generated from selected services</div>
                )}
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
