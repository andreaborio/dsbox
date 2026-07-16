import { useCallback, useEffect, useState } from "react";
import type { AppSnapshot, DsboxConfig, ServerEvent } from "../types";
import { apiRequest, postAction } from "../lib/api";
import {
  initialLiveConnectionState,
  transitionLiveConnection,
  type LiveConnectionStatus
} from "../lib/live-connection";

export interface DsboxController {
  snapshot: AppSnapshot | null;
  connected: boolean;
  connectionStatus: LiveConnectionStatus;
  lastEventAt: number | null;
  busyAction: string | null;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  saveConfig: (config: DsboxConfig) => Promise<void>;
  action: (name: string, path: string, body?: unknown) => Promise<void>;
}

export function useDsbox(): DsboxController {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [connection, setConnection] = useState(initialLiveConnectionState);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await apiRequest<AppSnapshot>("/api/state");
    setSnapshot(next);
  }, []);

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    const events = new EventSource("/api/events");
    events.onopen = () => setConnection((current) => transitionLiveConnection(current, { type: "opened", at: Date.now() }));
    events.onerror = () => setConnection((current) => transitionLiveConnection(current, { type: "error" }));
    events.addEventListener("dsbox", (raw) => {
      setConnection((current) => transitionLiveConnection(current, { type: "message", at: Date.now() }));
      const event = JSON.parse((raw as MessageEvent<string>).data) as ServerEvent;
      setSnapshot((current) => {
        if (event.type === "snapshot") return event.payload;
        if (!current) return current;
        if (event.type === "runtime") return { ...current, runtime: event.payload };
        if (event.type === "download") {
          const downloads = [
            event.payload,
            ...(current.downloads ?? []).filter((download) => download.id !== event.payload.id)
          ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
          return { ...current, downloads };
        }
        if (event.type === "config") return { ...current, config: event.payload };
        if (event.type === "activity") return { ...current, activity: event.payload };
        if (event.type === "log") {
          return { ...current, logs: [...current.logs, event.payload].slice(-1200) };
        }
        if (event.type === "metrics") {
          return { ...current, metrics: [...current.metrics, event.payload].slice(-180) };
        }
        return current;
      });
    });
    return () => events.close();
  }, [refresh]);

  const saveConfig = useCallback(async (config: DsboxConfig) => {
    setBusyAction("Saving configuration");
    setError(null);
    try {
      const next = await apiRequest<DsboxConfig>("/api/config", {
        method: "PUT",
        body: JSON.stringify(config)
      });
      setSnapshot((current) => current ? { ...current, config: next } : current);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      throw reason;
    } finally {
      setBusyAction(null);
    }
  }, []);

  const action = useCallback(async (name: string, path: string, body?: unknown) => {
    setBusyAction(name);
    setError(null);
    try {
      await postAction(path, body);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      throw reason;
    } finally {
      setBusyAction(null);
    }
  }, []);

  return {
    snapshot,
    connected: connection.status === "live",
    connectionStatus: connection.status,
    lastEventAt: connection.lastEventAt,
    busyAction,
    error,
    clearError: () => setError(null),
    refresh,
    saveConfig,
    action
  };
}
