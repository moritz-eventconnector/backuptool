import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { Plus, Trash2, Server, Copy, CheckCircle, XCircle, Terminal, RefreshCw } from "lucide-react";
import { useWsEvent } from "../context/WebSocketContext.tsx";

type OsTab = "linux" | "windows" | "manual";

export default function Agents() {
  const qc = useQueryClient();
  const { data: agents = [], isLoading } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [addResult, setAddResult] = useState<{ agentId: string; registrationToken: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [osTab, setOsTab] = useState<OsTab>("linux");

  const addMut = useMutation({
    mutationFn: () => api.generateAgentToken(newName || "New Agent"),
    onSuccess: (data) => { setAddResult(data); qc.invalidateQueries({ queryKey: ["agents"] }); },
  });

  const deleteMut = useMutation({
    mutationFn: api.deleteAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  const [updateMsg, setUpdateMsg] = useState<Record<string, { text: string; ok: boolean | null }>>({});
  // Track which agents currently have an update in flight
  const pendingUpdates = useRef<Set<string>>(new Set());
  const updateTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const updateMut = useMutation({
    mutationFn: (id: string) => api.updateAgent(id),
    onSuccess: (_, id) => {
      pendingUpdates.current.add(id);
      setUpdateMsg((m) => ({ ...m, [id]: { text: "Command sent — waiting for agent…", ok: null } }));
      // Timeout: if no ack in 30s, show error
      clearTimeout(updateTimers.current.get(id));
      updateTimers.current.set(id, setTimeout(() => {
        if (pendingUpdates.current.has(id)) {
          pendingUpdates.current.delete(id);
          setUpdateMsg((m) => ({ ...m, [id]: { text: "No response from agent — check server logs or restart agent service manually", ok: false } }));
        }
      }, 30_000));
    },
    onError: (e: Error, id) => setUpdateMsg((m) => ({ ...m, [id]: { text: e.message, ok: false } })),
  });

  useWsEvent(["agent_status", "update_ack"] as const, (msg) => {
    if (msg.type === "update_ack") {
      const id = msg.agentId as string;
      const status = msg.status as string;
      if (status === "already_current") {
        clearTimeout(updateTimers.current.get(id));
        pendingUpdates.current.delete(id);
        setUpdateMsg((m) => ({ ...m, [id]: { text: "Already up to date.", ok: true } }));
      } else if (status === "checking") {
        setUpdateMsg((m) => ({ ...m, [id]: { text: "Downloading update…", ok: null } }));
      }
    } else if (msg.type === "agent_status") {
      const id = msg.agentId as string;
      qc.invalidateQueries({ queryKey: ["agents"] });
      if (msg.status === "online" && pendingUpdates.current.has(id)) {
        clearTimeout(updateTimers.current.get(id));
        pendingUpdates.current.delete(id);
        const version = msg.version as string | undefined;
        setUpdateMsg((m) => ({ ...m, [id]: { text: `Updated successfully${version ? ` — now v${version}` : ""}`, ok: true } }));
      }
    }
  });

  const serverOrigin = window.location.origin;

  const installCmd = (tab: OsTab, agentId: string, token: string): string => {
    const base = `${serverOrigin}/api/agents/install/${agentId}/${token}`;
    if (tab === "linux") return `curl -sSL ${base}/install.sh | sudo bash`;
    if (tab === "windows") return `irm ${base}/install.ps1 | iex`;
    return `backuptool-agent --server ${serverOrigin} --agent-id ${agentId} --token ${token} --name "$(hostname)"`;
  };

  const copyCmd = () => {
    if (!addResult) return;
    navigator.clipboard.writeText(installCmd(osTab, addResult.agentId, addResult.registrationToken));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <div className="page-header">
        <h1>Agents</h1>
        <button className="btn-primary" onClick={() => { setShowAdd(true); setAddResult(null); setNewName(""); setCopied(false); }}>
          <Plus size={15} style={{ marginRight: 6 }} />Add Agent
        </button>
      </div>

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : agents.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Server size={40} />
            <p style={{ marginTop: 8 }}>No agents registered yet</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>Click "Add Agent" to generate a one-line install command</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr><th>Name</th><th>Hostname</th><th>Platform</th><th>Status</th><th>Last Seen</th><th>Version</th><th></th></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 500 }}>{a.name}</td>
                  <td style={{ color: "var(--text-muted)" }}>{a.hostname}</td>
                  <td><span className="badge badge-muted">{a.os}/{a.arch}</span></td>
                  <td>
                    <span className={`badge ${a.status === "online" ? "badge-success" : a.status === "busy" ? "badge-primary" : "badge-muted"}`}>
                      {a.status === "online" ? <CheckCircle size={11} /> : <XCircle size={11} />}
                      {a.status}
                    </span>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{a.lastSeen ? new Date(a.lastSeen).toLocaleString() : "Never"}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{a.version}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "flex-end" }}>
                      {updateMsg[a.id]?.text && (
                        <span style={{
                          fontSize: 11, marginRight: 4,
                          color: updateMsg[a.id].ok === true ? "var(--success, #22c55e)"
                               : updateMsg[a.id].ok === false ? "var(--danger)"
                               : "var(--text-muted)",
                          display: "flex", alignItems: "center", gap: 4,
                        }}>
                          {updateMsg[a.id].ok === null && <span className="spinner" style={{ width: 10, height: 10 }} />}
                          {updateMsg[a.id].text}
                        </span>
                      )}
                      <button className="btn-ghost" style={{ padding: "4px 8px" }}
                        title={a.status === "online" ? "Push update to agent" : "Agent offline — restart service to auto-update"}
                        disabled={updateMut.isPending}
                        onClick={() => {
                          setUpdateMsg((m) => ({ ...m, [a.id]: { text: "", ok: null } }));
                          updateMut.mutate(a.id);
                        }}>
                        <RefreshCw size={13} color={a.status === "online" ? "var(--primary)" : "var(--text-muted)"} />
                      </button>
                      <button className="btn-ghost" style={{ padding: "4px 8px" }}
                        onClick={() => { if (confirm(`Delete agent "${a.name}"?`)) deleteMut.mutate(a.id); }}>
                        <Trash2 size={13} color="var(--danger)" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Agent Modal */}
      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Agent</h2>
              <button className="btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setShowAdd(false)}>✕</button>
            </div>

            {!addResult ? (
              <>
                <div className="form-group">
                  <label>Agent Name</label>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="web-server-01" autoFocus />
                  <small style={{ color: "var(--text-muted)", fontSize: 12 }}>A descriptive name for this machine (e.g. "Passbolt Production")</small>
                </div>
                <div className="modal-footer">
                  <button className="btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                  <button className="btn-primary" onClick={() => addMut.mutate()} disabled={addMut.isPending}>
                    {addMut.isPending ? "Generating…" : "Generate Install Command"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="alert alert-success" style={{ marginBottom: 16 }}>
                  Token generated. Run the command below on your target machine — it will automatically download, install and register the agent.
                </div>

                {/* OS Tabs */}
                <div style={{ display: "flex", gap: 2, marginBottom: 0, borderBottom: "1px solid var(--border)" }}>
                  {([["linux", "Linux / macOS"], ["windows", "Windows"], ["manual", "Manual"]] as [OsTab, string][]).map(([tab, label]) => (
                    <button key={tab} onClick={() => { setOsTab(tab); setCopied(false); }}
                      className="btn-ghost"
                      style={{ borderRadius: "var(--radius) var(--radius) 0 0", paddingBottom: 8, borderBottom: osTab === tab ? "2px solid var(--primary)" : "2px solid transparent", color: osTab === tab ? "var(--primary)" : "var(--text-muted)", fontSize: 13 }}>
                      {label}
                    </button>
                  ))}
                </div>

                {/* Command box */}
                <div style={{ background: "#0a0c12", borderRadius: "0 0 var(--radius) var(--radius)", padding: "14px 16px", fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", marginBottom: 12, border: "1px solid var(--border)", borderTop: "none", display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <Terminal size={14} color="var(--primary)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <code style={{ color: "#e2e8f0", flex: 1 }}>
                    {installCmd(osTab, addResult.agentId, addResult.registrationToken)}
                  </code>
                </div>

                {osTab === "linux" && (
                  <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 12 }}>
                    Detects Linux or macOS automatically. Installs to <code>/usr/local/bin/</code>, creates a systemd service (Linux) or launchd daemon (macOS). Requires <code>sudo</code>.
                  </div>
                )}
                {osTab === "windows" && (
                  <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 12 }}>
                    Run in an <strong>elevated PowerShell</strong> (Run as Administrator). Installs to <code>Program Files\BackupTool\</code> and creates a Windows Service.
                  </div>
                )}
                {osTab === "manual" && (
                  <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 12 }}>
                    Download the correct binary from <code>{window.location.origin}/api/agents/binary/linux/amd64</code> (adjust OS/arch), make it executable and run this command. See README for systemd setup.
                  </div>
                )}

                <button className="btn-ghost" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} onClick={copyCmd}>
                  {copied ? <CheckCircle size={14} color="var(--success)" /> : <Copy size={14} />}
                  {copied ? "Copied!" : "Copy Command"}
                </button>

                <div className="modal-footer" style={{ marginTop: 12 }}>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", flex: 1 }}>The token is single-use and will be invalidated after the agent registers.</p>
                  <button className="btn-primary" onClick={() => setShowAdd(false)}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
