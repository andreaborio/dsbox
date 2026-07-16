import { describe, expect, it } from "vitest";
// @ts-expect-error The server test project does not enable JSX; Vitest compiles this UI module through Vite.
import { defaultReasoningExpanded, defaultSourcesExpanded, reasoningTraceItems, resolveWebSearchControl, sourceIndexForCitation } from "../src/views/ChatView.js";
import { DEFAULT_WEB_SEARCH_ENABLED } from "../src/lib/chat-session.js";
import type { ChatMessage, ChatToolActivity } from "../src/types.js";

function tool(callId: string, step: number, name = "web_search"): ChatToolActivity {
  return {
    callId,
    step,
    name,
    state: "succeeded",
    argumentsText: "{}",
    createdAt: 1_000,
    completedAt: 1_100,
    durationMs: 100
  };
}

describe("Chat Web control", () => {
  it("resolves stable Agent citation IDs without relying on merged result order", () => {
    const sources = [
      { title: "First", url: "https://example.com/first", snippet: "", citationId: "S1" },
      { title: "Second query", url: "https://example.com/second", snippet: "", citationId: "S7" }
    ];
    expect(sourceIndexForCitation(sources, "S7")).toBe(1);
    expect(sourceIndexForCitation(sources, "7")).toBe(1);
    expect(sourceIndexForCitation(sources, "2")).toBe(-1);
    expect(sourceIndexForCitation(sources.map((source) => ({ title: source.title, url: source.url, snippet: source.snippet })), "2")).toBe(1);
  });

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

  it("keeps the shared Web gate enabled when Agent is toggled off", () => {
    expect(resolveWebSearchControl({
      agentAvailable: true,
      agentActive: false,
      tools: ["web_search"],
      preference: true,
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

  it("keeps Web configurable for the standard-chat fallback", () => {
    expect(resolveWebSearchControl({
      agentAvailable: false,
      agentActive: false,
      tools: ["web_search"],
      preference: true,
      streaming: false
    })).toMatchObject({ visible: true, requestEnabled: true, pressed: true });
  });

  it("keeps the network gate visible without tool capability and only disables changes while streaming", () => {
    expect(resolveWebSearchControl({
      agentAvailable: true,
      agentActive: true,
      tools: ["runtime_status"],
      preference: true,
      streaming: false
    })).toMatchObject({ visible: true, requestEnabled: true });

    expect(resolveWebSearchControl({
      agentAvailable: true,
      agentActive: true,
      tools: ["web_search"],
      preference: true,
      streaming: true
    })).toMatchObject({ visible: true, requestEnabled: true, pressed: true, disabled: true });
  });
});

describe("Source disclosure", () => {
  it("keeps a few sources visible and collapses larger research sets", () => {
    expect(defaultSourcesExpanded(0)).toBe(false);
    expect(defaultSourcesExpanded(1)).toBe(true);
    expect(defaultSourcesExpanded(3)).toBe(true);
    expect(defaultSourcesExpanded(4)).toBe(false);
    expect(defaultSourcesExpanded(12)).toBe(false);
  });
});

describe("Reasoning trace", () => {
  it("only auto-expands while reasoning is live before the answer starts", () => {
    expect(defaultReasoningExpanded({ content: "", pending: true, error: undefined })).toBe(true);
    expect(defaultReasoningExpanded({ content: "\n", pending: true, error: false })).toBe(true);
    expect(defaultReasoningExpanded({ content: "Answer streaming", pending: true, error: undefined })).toBe(false);
    expect(defaultReasoningExpanded({ content: "Answer complete", pending: false, error: undefined })).toBe(false);
    expect(defaultReasoningExpanded({
      content: "Partial answer",
      pending: true,
      error: false,
      blocks: [{ type: "tool_call", activity: { ...tool("live-tool", 2), state: "running" } }]
    })).toBe(true);
    expect(defaultReasoningExpanded({ content: "Failed", pending: false, error: true })).toBe(true);
  });

  it("keeps reasoning and tool rounds in causal order while grouping parallel calls", () => {
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "Final answer",
      reasoning: "Plan.Check.",
      blocks: [
        { type: "reasoning", text: "Plan." },
        { type: "tool_call", activity: tool("web-1", 1) },
        { type: "tool_call", activity: tool("web-2", 1) },
        { type: "reasoning", text: "Check." },
        { type: "tool_call", activity: tool("local-1", 2, "model_info") },
        { type: "text", text: "Final answer" }
      ]
    };

    const items = reasoningTraceItems(message);
    expect(items.map((item: { type: string }) => item.type)).toEqual(["reasoning", "tools", "reasoning", "tools"]);
    expect(items[1]).toMatchObject({
      type: "tools",
      step: 1,
      activities: [{ callId: "web-1" }, { callId: "web-2" }]
    });
    expect(items[3]).toMatchObject({
      type: "tools",
      step: 2,
      activities: [{ callId: "local-1" }]
    });
  });

  it("keeps legacy aggregate reasoning visible when persisted blocks lack it", () => {
    const message: ChatMessage = {
      id: "assistant-legacy",
      role: "assistant",
      content: "Done",
      reasoning: "Legacy reasoning",
      blocks: [
        { type: "tool_call", activity: tool("legacy-tool", 1, "runtime_status") },
        { type: "text", text: "Done" }
      ]
    };

    expect(reasoningTraceItems(message)).toMatchObject([
      { type: "reasoning", text: "Legacy reasoning" },
      { type: "tools", activities: [{ callId: "legacy-tool" }] }
    ]);
  });

  it("does not merge tool groups across reasoning boundaries or without a model step", () => {
    const message: ChatMessage = {
      id: "assistant-boundaries",
      role: "assistant",
      content: "Done",
      reasoning: "Between calls",
      blocks: [
        { type: "tool_call", activity: tool("before", 3) },
        { type: "reasoning", text: "Between calls" },
        { type: "tool_call", activity: tool("after", 3, "model_info") },
        { type: "tool_call", activity: { ...tool("unstepped-web", 4), step: undefined } },
        { type: "tool_call", activity: { ...tool("unstepped-local", 4, "runtime_status"), step: undefined } }
      ]
    };

    const items = reasoningTraceItems(message);
    expect(items.map((item: { type: string }) => item.type)).toEqual([
      "tools",
      "reasoning",
      "tools",
      "tools",
      "tools"
    ]);
    expect(items.filter((item: { type: string }) => item.type === "tools")).toHaveLength(4);
  });
});
