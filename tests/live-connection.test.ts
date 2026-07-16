import { describe, expect, it } from "vitest";
import { initialLiveConnectionState, transitionLiveConnection } from "../src/lib/live-connection.js";

describe("live update connection state", () => {
  it("distinguishes initial connection, live updates, and reconnection", () => {
    const initial = initialLiveConnectionState;
    const unavailable = transitionLiveConnection(initial, { type: "error" });
    const opened = transitionLiveConnection(unavailable, { type: "opened", at: 100 });
    const updated = transitionLiveConnection(opened, { type: "message", at: 140 });
    const reconnecting = transitionLiveConnection(updated, { type: "error" });
    const restored = transitionLiveConnection(reconnecting, { type: "opened", at: 220 });

    expect(initial).toEqual({ status: "connecting", hasConnected: false, lastEventAt: null });
    expect(unavailable).toEqual({ status: "reconnecting", hasConnected: false, lastEventAt: null });
    expect(opened).toEqual({ status: "live", hasConnected: true, lastEventAt: 100 });
    expect(updated).toEqual({ status: "live", hasConnected: true, lastEventAt: 140 });
    expect(reconnecting).toEqual({ status: "reconnecting", hasConnected: true, lastEventAt: 140 });
    expect(restored).toEqual({ status: "live", hasConnected: true, lastEventAt: 220 });
  });
});
