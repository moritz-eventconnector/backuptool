import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { Plus, Trash2, Server, Copy, CheckCircle, XCircle } from "lucide-react";

export default function Agents() {
  const qc = useQueryClient();
  const { data: agents = [], isLoading } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [addResult, setAddResult] = useState<{ agentId: string; registrationToken: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const addMut = useMutation({
    mutationFn: () => api.generateAgentToken(newName || "New Agent"),
    onSuccess: (data) => {
      setAddResult(data);
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: api.deleteAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  const copyToken = () => {
    if (!addResult) return;
    const cmd = `backuptool-agent --server http://YOUR_SERVER:3000 --agent-id ${addResult.agentId} --token ${addResult.registrationToken}`;
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <div className="page-header">
        <h1>Agents</h1>
        <button className="btn-primary" onClick={() => { setShowAdd(true); setAddResult(null); setNewName(""); }}>
          <Plus size={15} style={{ marginRight: 6 }} />
          Add Agent
        </button>
      </div>

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : agents.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Server size={40} />
            <p style={{ marginTop: 8 }}>No agents registered yet</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>Click "Add Agent" to generate a registration token</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Hostname</th>
                <th>Platform</th>
                <th>Status</th>
                <th>Last Seen</th>
                <th>Version</th>
                <th></th>
              </tr>
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
                  <td style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {a.lastSeen ? new Date(a.lastSeen).toLocaleString() : "Never"}
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{a.version}</td>
                  <td>
                    <button className="btn-ghost" style={{ padding: "4px 8px" }}
                      onClick={() => { if (confirm(`Delete agent "${a.name}"?`)) deleteMut.mutate(a.id); }}>
                      <Trash2 size={13} color="var(--danger)" />
                    </button>
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
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Agent</h2>
              <button className="btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setShowAdd(false)}>✕</button>
            </div>

            {!addResult ? (
              <>
                <div className="form-group">
                  <label>Agent Name</label>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Server" autoFocus />
                </div>
                <div className="modal-footer">
                  <button className="btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                  <button className="btn-primary" onClick={() => addMut.mutate()} disabled={addMut.isPending}>
                    {addMut.isPending ? "Generating..." : "Generate Token"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="alert alert-success">Token generated! Run this command on your target machine:</div>
                <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 12, fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", marginBottom: 16 }}>
                  <code>backuptool-agent --server http://YOUR_SERVER:3000 --agent-id {addResult.agentId} --token {addResult.registrationToken}</code>
                </div>
                <button className="btn-ghost" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} onClick={copyToken}>
                  {copied ? <CheckCircle size={14} color="var(--success)" /> : <Copy size={14} />}
                  {copied ? "Copied!" : "Copy Command"}
                </button>
                <div className="modal-footer">
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
