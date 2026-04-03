import { useState, useEffect } from "react";

interface Props {
  value: string;
  onChange: (cron: string) => void;
}

const PRESETS = [
  { label: "Every hour",        cron: "0 * * * *" },
  { label: "Every 6 hours",     cron: "0 */6 * * *" },
  { label: "Daily at 2am",      cron: "0 2 * * *" },
  { label: "Daily at midnight", cron: "0 0 * * *" },
  { label: "Weekly (Sun 3am)",  cron: "0 3 * * 0" },
  { label: "Monthly (1st 4am)", cron: "0 4 1 * *" },
  { label: "Custom",            cron: "" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, i) => i + 1);

type Mode = "preset" | "daily" | "weekly" | "monthly" | "custom";

function detectMode(cron: string): Mode {
  if (!cron) return "preset";
  if (PRESETS.slice(0, -1).some((p) => p.cron === cron)) return "preset";
  const parts = cron.split(" ");
  if (parts.length !== 5) return "custom";
  const [, , dom, , dow] = parts;
  if (dom === "*" && dow === "*") return "daily";
  if (dom === "*" && dow !== "*") return "weekly";
  if (dom !== "*" && dow === "*") return "monthly";
  return "custom";
}

export function CronPicker({ value, onChange }: Props) {
  const [mode, setMode] = useState<Mode>(() => detectMode(value));
  const [hour, setHour] = useState(() => {
    const parts = value?.split(" ");
    return parts?.[1] && parts[1] !== "*" ? parseInt(parts[1]) : 2;
  });
  const [dayOfWeek, setDayOfWeek] = useState(() => {
    const parts = value?.split(" ");
    return parts?.[4] && parts[4] !== "*" ? parseInt(parts[4]) : 0;
  });
  const [dayOfMonth, setDayOfMonth] = useState(() => {
    const parts = value?.split(" ");
    return parts?.[2] && parts[2] !== "*" ? parseInt(parts[2]) : 1;
  });
  const [customCron, setCustomCron] = useState(value || "");

  useEffect(() => {
    let cron = "";
    if (mode === "preset") {
      // handled by preset click
      return;
    } else if (mode === "daily") {
      cron = `0 ${hour} * * *`;
    } else if (mode === "weekly") {
      cron = `0 ${hour} * * ${dayOfWeek}`;
    } else if (mode === "monthly") {
      cron = `0 ${hour} ${dayOfMonth} * *`;
    } else {
      cron = customCron;
    }
    if (cron && cron !== value) onChange(cron);
  }, [mode, hour, dayOfWeek, dayOfMonth, customCron]);

  const matchedPreset = PRESETS.find((p) => p.cron === value && p.cron !== "");

  const fmtHour = (h: number) => {
    if (h === 0) return "12am";
    if (h === 12) return "12pm";
    return h < 12 ? `${h}am` : `${h - 12}pm`;
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
      {/* Mode tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
        {(["preset", "daily", "weekly", "monthly", "custom"] as Mode[]).map((m) => (
          <button key={m} type="button"
            onClick={() => setMode(m)}
            style={{
              flex: 1, padding: "8px 4px", fontSize: 12, border: "none", cursor: "pointer",
              background: mode === m ? "var(--bg-card)" : "transparent",
              color: mode === m ? "var(--primary)" : "var(--text-muted)",
              fontWeight: mode === m ? 600 : 400,
              borderBottom: mode === m ? "2px solid var(--primary)" : "2px solid transparent",
              textTransform: "capitalize",
            }}>
            {m}
          </button>
        ))}
      </div>

      <div style={{ padding: "14px 14px 12px", background: "var(--bg-card)" }}>
        {/* Presets */}
        {mode === "preset" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {PRESETS.slice(0, -1).map((p) => (
              <button key={p.cron} type="button"
                onClick={() => { onChange(p.cron); }}
                style={{
                  padding: "8px 12px", borderRadius: "var(--radius)", fontSize: 13,
                  border: `1px solid ${value === p.cron ? "var(--primary)" : "var(--border)"}`,
                  background: value === p.cron ? "rgba(99,102,241,.12)" : "var(--bg)",
                  color: value === p.cron ? "var(--primary)" : "var(--text-secondary)",
                  cursor: "pointer", textAlign: "left",
                }}>
                {p.label}
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", marginTop: 2 }}>{p.cron}</div>
              </button>
            ))}
          </div>
        )}

        {/* Daily */}
        {mode === "daily" && (
          <div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 10 }}>Every day at…</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((h) => (
                <button key={h} type="button" onClick={() => setHour(h)}
                  style={{
                    padding: "5px 10px", borderRadius: "var(--radius)", fontSize: 12,
                    border: `1px solid ${hour === h ? "var(--primary)" : "var(--border)"}`,
                    background: hour === h ? "rgba(99,102,241,.12)" : "var(--bg)",
                    color: hour === h ? "var(--primary)" : "var(--text-secondary)",
                    cursor: "pointer",
                  }}>
                  {fmtHour(h)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Weekly */}
        {mode === "weekly" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>Day of week</div>
              <div style={{ display: "flex", gap: 5 }}>
                {DAYS_OF_WEEK.map((d, i) => (
                  <button key={i} type="button" onClick={() => setDayOfWeek(i)}
                    style={{
                      flex: 1, padding: "6px 2px", borderRadius: "var(--radius)", fontSize: 12,
                      border: `1px solid ${dayOfWeek === i ? "var(--primary)" : "var(--border)"}`,
                      background: dayOfWeek === i ? "rgba(99,102,241,.12)" : "var(--bg)",
                      color: dayOfWeek === i ? "var(--primary)" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>At hour</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((h) => (
                  <button key={h} type="button" onClick={() => setHour(h)}
                    style={{
                      padding: "5px 10px", borderRadius: "var(--radius)", fontSize: 12,
                      border: `1px solid ${hour === h ? "var(--primary)" : "var(--border)"}`,
                      background: hour === h ? "rgba(99,102,241,.12)" : "var(--bg)",
                      color: hour === h ? "var(--primary)" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}>
                    {fmtHour(h)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Monthly */}
        {mode === "monthly" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>Day of month</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {DAYS_OF_MONTH.map((d) => (
                  <button key={d} type="button" onClick={() => setDayOfMonth(d)}
                    style={{
                      width: 34, height: 34, borderRadius: "var(--radius)", fontSize: 12,
                      border: `1px solid ${dayOfMonth === d ? "var(--primary)" : "var(--border)"}`,
                      background: dayOfMonth === d ? "rgba(99,102,241,.12)" : "var(--bg)",
                      color: dayOfMonth === d ? "var(--primary)" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>At hour</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((h) => (
                  <button key={h} type="button" onClick={() => setHour(h)}
                    style={{
                      padding: "5px 10px", borderRadius: "var(--radius)", fontSize: 12,
                      border: `1px solid ${hour === h ? "var(--primary)" : "var(--border)"}`,
                      background: hour === h ? "rgba(99,102,241,.12)" : "var(--bg)",
                      color: hour === h ? "var(--primary)" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}>
                    {fmtHour(h)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Custom */}
        {mode === "custom" && (
          <div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>Cron expression (minute hour day month weekday)</div>
            <input
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
              placeholder="0 2 * * *"
              style={{ fontFamily: "monospace", width: "100%" }}
            />
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
              Examples: <code>0 */6 * * *</code> (every 6h) · <code>30 1 * * 1-5</code> (Mon–Fri 1:30am)
            </div>
          </div>
        )}

        {/* Summary */}
        {value && mode !== "custom" && (
          <div style={{ marginTop: 12, padding: "6px 10px", background: "var(--bg)", borderRadius: "var(--radius)", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)" }}>
              {matchedPreset?.label ?? describeCron(value)}
            </span>
            <code style={{ fontSize: 11, color: "var(--primary)" }}>{value}</code>
          </div>
        )}
      </div>
    </div>
  );
}

function describeCron(cron: string): string {
  const [min, h, dom, , dow] = cron.split(" ");
  const fmtH = (v: string) => {
    const n = parseInt(v);
    if (isNaN(n)) return v;
    if (n === 0) return "12am";
    if (n === 12) return "12pm";
    return n < 12 ? `${n}am` : `${n - 12}pm`;
  };
  if (dom === "*" && dow === "*") return `Daily at ${fmtH(h)}`;
  if (dom === "*" && dow !== "*") {
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    return `Every ${days[parseInt(dow)] ?? dow} at ${fmtH(h)}`;
  }
  if (dom !== "*" && dow === "*") return `Monthly on day ${dom} at ${fmtH(h)}`;
  return cron;
}
