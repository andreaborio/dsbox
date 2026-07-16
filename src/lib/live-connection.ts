export type LiveConnectionStatus = "connecting" | "live" | "reconnecting";

export interface LiveConnectionState {
  status: LiveConnectionStatus;
  hasConnected: boolean;
  lastEventAt: number | null;
}

export type LiveConnectionEvent =
  | { type: "opened"; at: number }
  | { type: "message"; at: number }
  | { type: "error" };

export const initialLiveConnectionState: LiveConnectionState = {
  status: "connecting",
  hasConnected: false,
  lastEventAt: null
};

export function transitionLiveConnection(
  state: LiveConnectionState,
  event: LiveConnectionEvent
): LiveConnectionState {
  if (event.type === "error") {
    return { ...state, status: "reconnecting" };
  }

  return {
    status: "live",
    hasConnected: true,
    lastEventAt: event.at
  };
}
