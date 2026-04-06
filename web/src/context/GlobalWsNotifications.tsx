/**
 * Listens to app-wide WebSocket events and fires toast notifications.
 * Rendered once inside the WS + Notification providers.
 */
import { useEffect } from "react";
import { useWebSocket } from "./WebSocketContext.tsx";
import { useNotify } from "./NotificationContext.tsx";

export function GlobalWsNotifications() {
  const { subscribeAny } = useWebSocket();
  const notify = useNotify();

  useEffect(() => {
    return subscribeAny((msg) => {
      const type = msg.type as string;

      if (type === "snapshot_done") {
        const status = msg.status as string;
        const jobName = (msg.jobName as string) ?? "Backup";
        const dur = msg.durationSeconds != null ? ` in ${(msg.durationSeconds as number).toFixed(1)}s` : "";
        const size = msg.sizeBytes != null ? ` · ${fmtSize(msg.sizeBytes as number)}` : "";
        if (status === "success") {
          notify({ kind: "success", title: `${jobName} completed`, message: `Backup successful${dur}${size}` });
        } else if (status === "failed") {
          const err = (msg.errorMessage as string) ?? "unknown error";
          notify({ kind: "error", title: `${jobName} failed`, message: err, duration: 0 });
        } else if (status === "warning") {
          notify({ kind: "warning", title: `${jobName} completed with warnings`, message: "Integrity check failed — see Snapshots for details" });
        }
        return;
      }

      if (type === "verify_result") {
        const status = msg.status as string;
        const name = (msg.jobName as string) ?? "Job";
        if (status === "passed") {
          notify({ kind: "success", title: `Verification passed`, message: `${name} — data integrity confirmed` });
        } else {
          const err = (msg.message as string) ?? "data corruption detected";
          notify({ kind: "error", title: `Verification FAILED`, message: `${name} — ${err}`, duration: 0 });
        }
        return;
      }

      if (type === "rotate_key_result") {
        const status = msg.status as string;
        const name = (msg.jobName as string) ?? "Job";
        if (status === "success") {
          notify({ kind: "success", title: "Key rotation complete", message: `${name} — new encryption key active` });
        } else {
          notify({ kind: "error", title: "Key rotation failed", message: `${name} — old key kept`, duration: 0 });
        }
        return;
      }

      if (type === "update_ack") {
        const status = msg.status as string;
        const name = (msg.agentName as string) ?? "Agent";
        if (status === "already_current") {
          notify({ kind: "info", title: "Agent already up to date", message: name });
        } else if (status === "checking") {
          notify({ kind: "info", title: "Agent updating…", message: `${name} is downloading the new binary`, duration: 3000 });
        }
        return;
      }

      if (type === "agent_status") {
        const status = msg.status as string;
        const name = (msg.agentName as string) ?? "Agent";
        const version = msg.version as string | undefined;
        if (status === "online" && version) {
          // Only show when reconnecting (agent self-update causes a reconnect)
          notify({ kind: "success", title: `${name} online`, message: version ? `v${version}` : undefined, duration: 4000 });
        } else if (status === "offline") {
          notify({ kind: "warning", title: `${name} disconnected`, duration: 4000 });
        }
        return;
      }

      if (type === "restore_result") {
        const status = msg.status as string;
        if (status === "success") {
          notify({ kind: "success", title: "Restore complete", message: `Files restored to: ${msg.restorePath}` });
        } else {
          notify({ kind: "error", title: "Restore failed", message: (msg.errorMessage as string) ?? "unknown error", duration: 0 });
        }
        return;
      }
    });
  }, [subscribeAny, notify]);

  return null;
}

function fmtSize(bytes: number) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}
