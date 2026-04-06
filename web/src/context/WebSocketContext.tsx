import { createContext, useContext, useEffect, useRef, useCallback, type ReactNode } from "react";
import { config } from "../config.ts";

type MessageHandler = (msg: Record<string, unknown>) => void;

interface WebSocketContextValue {
  subscribe: (type: string, handler: MessageHandler) => () => void;
  subscribeAny: (handler: MessageHandler) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  // Map from message type → set of handlers; "_any" = catch-all
  const listenersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());

  const dispatch = useCallback((msg: Record<string, unknown>) => {
    const type = msg.type as string;
    listenersRef.current.get(type)?.forEach((h) => h(msg));
    listenersRef.current.get("_any")?.forEach((h) => h(msg));
  }, []);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let dead = false;

    function connect() {
      if (dead) return;
      const ws = new WebSocket(config.wsUrl);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "ui_connect" }));
      ws.onmessage = (e) => {
        try { dispatch(JSON.parse(e.data)); } catch { /**/ }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!dead) reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      dead = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [dispatch]);

  const subscribe = useCallback((type: string, handler: MessageHandler) => {
    if (!listenersRef.current.has(type)) listenersRef.current.set(type, new Set());
    listenersRef.current.get(type)!.add(handler);
    return () => listenersRef.current.get(type)?.delete(handler);
  }, []);

  const subscribeAny = useCallback((handler: MessageHandler) => {
    return subscribe("_any", handler);
  }, [subscribe]);

  return (
    <WebSocketContext.Provider value={{ subscribe, subscribeAny }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error("useWebSocket must be used inside WebSocketProvider");
  return ctx;
}

/** Convenience: subscribe to one or more message types, auto-unsubscribes on unmount.
 *  Pass a stable reference (constant / useMemo) for the type array to avoid
 *  unnecessary effect re-runs. String keys are joined and used as the dep key. */
export function useWsEvent(type: string | readonly string[], handler: MessageHandler) {
  const { subscribe } = useWebSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  // Stable string key so a fresh array literal doesn't re-trigger the effect
  const typeKey = Array.isArray(type) ? (type as string[]).join(",") : (type as string);

  useEffect(() => {
    const types = typeKey.split(",");
    const stable: MessageHandler = (msg) => handlerRef.current(msg);
    const unsubs = types.map((t) => subscribe(t, stable));
    return () => unsubs.forEach((u) => u());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeKey, subscribe]);
}
