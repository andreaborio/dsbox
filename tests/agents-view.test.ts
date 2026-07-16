import { describe, expect, it } from "vitest";
// @ts-expect-error The server test project does not enable JSX; Vitest compiles this UI module through Vite.
import { resolveAgentConnectionPresentation } from "../src/views/AgentsView.js";

describe("Agents runtime truth", () => {
  it("never presents an offline selected model as agent-ready", () => {
    expect(resolveAgentConnectionPresentation({ phase: "idle", readiness: "offline" }, true)).toMatchObject({
      state: "offline",
      capabilityTitle: "Qwen3.6 · Configured",
      capabilityBadge: "Offline",
      actionLabel: "Open server"
    });
  });

  it.each([
    ["preparing", "offline"],
    ["starting", "loading"],
    ["running", "loading"],
    ["stopping", "offline"]
  ] as const)("treats %s/%s as a transition", (phase, readiness) => {
    expect(resolveAgentConnectionPresentation({ phase, readiness }, true)).toMatchObject({
      state: "loading",
      capabilityTitle: "Qwen3.6 · Starting",
      actionLabel: "Starting…"
    });
  });

  it("requires both a running phase and ready readiness", () => {
    expect(resolveAgentConnectionPresentation({ phase: "running", readiness: "ready" }, true)).toMatchObject({
      state: "ready",
      capabilityTitle: "Qwen3.6 · Agent ready",
      capabilityBadge: "Tools",
      actionLabel: "Check gateway"
    });
    expect(resolveAgentConnectionPresentation({ phase: "idle", readiness: "ready" }, true).state).toBe("offline");
  });
});
