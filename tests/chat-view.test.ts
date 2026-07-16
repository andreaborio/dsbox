import { describe, expect, it } from "vitest";
// @ts-expect-error The server test project does not enable JSX; Vitest compiles this UI module through Vite.
import { resolveWebSearchControl } from "../src/views/ChatView.js";
import { DEFAULT_WEB_SEARCH_ENABLED } from "../src/lib/chat-session.js";

describe("Chat Web control", () => {
  it("defaults Web on when Agent tools expose web_search", () => {
    expect(DEFAULT_WEB_SEARCH_ENABLED).toBe(true);
    expect(resolveWebSearchControl({
      agentAvailable: true,
      agentActive: true,
      tools: ["runtime_status", "web_search"],
      preference: DEFAULT_WEB_SEARCH_ENABLED,
      streaming: false
    })).toMatchObject({
      visible: true,
      requestEnabled: true,
      pressed: true,
      disabled: false,
      label: "Web on",
      ariaLabel: "Turn web search off"
    });
  });

  it("keeps the opt-out while Agent and capabilities change", () => {
    const preference = false;
    const states = [
      resolveWebSearchControl({ agentAvailable: true, agentActive: true, tools: ["web_search"], preference, streaming: false }),
      resolveWebSearchControl({ agentAvailable: true, agentActive: false, tools: ["web_search"], preference, streaming: false }),
      resolveWebSearchControl({ agentAvailable: false, agentActive: false, tools: [], preference, streaming: false }),
      resolveWebSearchControl({ agentAvailable: true, agentActive: true, tools: ["web_search"], preference, streaming: false })
    ];

    expect(states.map(({ pressed, label }) => ({ pressed, label }))).toEqual([
      { pressed: false, label: "Web off" },
      { pressed: false, label: "Web off" },
      { pressed: false, label: "Web off" },
      { pressed: false, label: "Web off" }
    ]);
    expect(states.map((state) => state.requestEnabled)).toEqual([false, false, false, false]);
  });

  it("preserves an on preference when Agent is toggled off without authorizing that request", () => {
    expect(resolveWebSearchControl({
      agentAvailable: true,
      agentActive: false,
      tools: ["web_search"],
      preference: true,
      streaming: false
    })).toMatchObject({
      visible: true,
      requestEnabled: false,
      pressed: true,
      disabled: false,
      label: "Web on",
      ariaLabel: "Turn web search off"
    });
  });

  it("hides Web without the capability and only disables preference changes while streaming", () => {
    expect(resolveWebSearchControl({
      agentAvailable: true,
      agentActive: true,
      tools: ["runtime_status"],
      preference: true,
      streaming: false
    })).toMatchObject({ visible: false, requestEnabled: false });

    expect(resolveWebSearchControl({
      agentAvailable: true,
      agentActive: true,
      tools: ["web_search"],
      preference: true,
      streaming: true
    })).toMatchObject({ visible: true, requestEnabled: true, pressed: true, disabled: true });
  });
});
