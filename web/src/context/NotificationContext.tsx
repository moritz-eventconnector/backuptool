import { createContext, useContext, useCallback, useState, useEffect, useRef, type ReactNode } from "react";
import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-react";

export type NotifKind = "success" | "error" | "warning" | "info";

export interface Notification {
  id: string;
  kind: NotifKind;
  title: string;
  message?: string;
  duration?: number; // ms; 0 = sticky
}

interface NotificationContextValue {
  notify: (n: Omit<Notification, "id">) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

let _notify: NotificationContextValue["notify"] | null = null;

/** Call from anywhere (outside React tree) after the provider is mounted */
export function notify(n: Omit<Notification, "id">) {
  _notify?.(n);
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notification[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((n) => n.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const add = useCallback((n: Omit<Notification, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const duration = n.duration ?? 6000;
    setItems((prev) => [{ ...n, id }, ...prev].slice(0, 8));
    if (duration > 0) {
      const t = setTimeout(() => remove(id), duration);
      timers.current.set(id, t);
    }
  }, [remove]);

  // Expose globally
  useEffect(() => { _notify = add; return () => { _notify = null; }; }, [add]);

  return (
    <NotificationContext.Provider value={{ notify: add }}>
      {children}
      {/* Toast container */}
      <div style={{
        position: "fixed", bottom: 24, right: 24, zIndex: 9999,
        display: "flex", flexDirection: "column-reverse", gap: 8,
        maxWidth: 380, pointerEvents: "none",
      }}>
        {items.map((n) => <Toast key={n.id} n={n} onDismiss={remove} />)}
      </div>
    </NotificationContext.Provider>
  );
}

export function useNotify() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotify must be used inside NotificationProvider");
  return ctx.notify;
}

function Toast({ n, onDismiss }: { n: Notification; onDismiss: (id: string) => void }) {
  const kindStyle: Record<NotifKind, { border: string; icon: typeof CheckCircle; color: string }> = {
    success: { border: "var(--success, #22c55e)", icon: CheckCircle, color: "var(--success, #22c55e)" },
    error:   { border: "var(--danger, #ef4444)",  icon: XCircle,     color: "var(--danger, #ef4444)" },
    warning: { border: "var(--warning, #f59e0b)", icon: AlertTriangle, color: "var(--warning, #f59e0b)" },
    info:    { border: "var(--primary, #6366f1)", icon: Info,         color: "var(--primary, #6366f1)" },
  };
  const { border, icon: Icon, color } = kindStyle[n.kind];

  return (
    <div style={{
      pointerEvents: "all",
      background: "var(--bg-secondary)",
      border: "1px solid var(--border)",
      borderLeft: `4px solid ${border}`,
      borderRadius: "var(--radius)",
      padding: "10px 12px",
      display: "flex",
      alignItems: "flex-start",
      gap: 10,
      boxShadow: "0 4px 12px rgba(0,0,0,.25)",
      animation: "slideInRight .2s ease",
      minWidth: 280,
    }}>
      <Icon size={16} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{n.title}</div>
        {n.message && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, wordBreak: "break-word" }}>{n.message}</div>}
      </div>
      <button onClick={() => onDismiss(n.id)}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--text-muted)", flexShrink: 0 }}>
        <X size={13} />
      </button>
    </div>
  );
}
