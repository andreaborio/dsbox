import { describe, expect, it } from "vitest";
// @ts-expect-error The server test project does not enable JSX; Vitest compiles this UI module through Vite.
import { resolveMonitorPresentation } from "../src/views/MonitorView.js";

describe("Activity telemetry truth", () => {
  it("keeps host telemetry visible without claiming Hebrus Studio is active", () => {
    expect(resolveMonitorPresentation({ phase: "idle", readiness: "offline" }, "idle", null)).toEqual({
      state: "offline",
      title: "System resources. Hebrus Studio is off.",
      description: "Memory, CPU, and disk values describe this Mac. Runtime metrics remain off until Hebrus Studio starts.",
      modelStatus: "Offline",
      responseSpeed: "Off",
      responseFoot: "Runtime inactive"
    });
  });

  it("distinguishes startup telemetry from a ready runtime", () => {
    expect(resolveMonitorPresentation({ phase: "starting", readiness: "loading" }, "idle", null)).toMatchObject({
      state: "loading",
      modelStatus: "Loading",
      responseSpeed: "Loading…"
    });
    expect(resolveMonitorPresentation({ phase: "stopping", readiness: "offline" }, "idle", null)).toMatchObject({
      state: "loading",
      modelStatus: "Stopping",
      responseSpeed: "Stopping…"
    });
  });

  it("only reports measured speed during active inference", () => {
    expect(resolveMonitorPresentation({ phase: "running", readiness: "ready" }, "idle", 4.2)).toMatchObject({
      state: "ready",
      modelStatus: "Waiting",
      responseSpeed: "Waiting"
    });
    expect(resolveMonitorPresentation({ phase: "running", readiness: "ready" }, "decode", 4.2)).toMatchObject({
      state: "ready",
      modelStatus: "Decode",
      responseSpeed: "4.20 t/s",
      responseFoot: "Measured by Hebrus Studio"
    });
  });
});
