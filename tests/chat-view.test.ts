import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error The server test project does not enable JSX; Vitest compiles this UI module through Vite.
import { defaultReasoningExpanded, defaultSourcesExpanded, hiddenSourceCount, localThinkingPhrase, reasoningTraceItems, resolveWebSearchControl, sourceFaviconUrl, sourceIndexForCitation, sourcePreviewImageUrl, visibleSourceCount } from "../src/views/ChatView.js";
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
      modelSupportsTools: true,
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
      resolveWebSearchControl({ modelSupportsTools: true, agentAvailable: true, agentActive: true, tools: ["web_search"], preference, streaming: false }),
      resolveWebSearchControl({ modelSupportsTools: true, agentAvailable: true, agentActive: false, tools: ["web_search"], preference, streaming: false }),
      resolveWebSearchControl({ modelSupportsTools: true, agentAvailable: false, agentActive: false, tools: [], preference, streaming: false }),
      resolveWebSearchControl({ modelSupportsTools: true, agentAvailable: true, agentActive: true, tools: ["web_search"], preference, streaming: false })
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
      modelSupportsTools: true,
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

  it("keeps Web configurable for the Qwen standard-chat fallback", () => {
    expect(resolveWebSearchControl({
      modelSupportsTools: true,
      agentAvailable: false,
      agentActive: false,
      tools: ["web_search"],
      preference: true,
      streaming: false
    })).toMatchObject({ visible: true, requestEnabled: true, pressed: true });
  });

  it("locks Web on models that do not support tools yet", () => {
    expect(resolveWebSearchControl({
      modelSupportsTools: false,
      agentAvailable: false,
      agentActive: false,
      tools: [],
      preference: true,
      streaming: false
    })).toMatchObject({ visible: true, requestEnabled: false, pressed: false, disabled: true, label: "Web off" });
  });

  it("keeps the Qwen network gate visible without tool capability and only disables changes while streaming", () => {
    expect(resolveWebSearchControl({
      modelSupportsTools: true,
      agentAvailable: true,
      agentActive: true,
      tools: ["runtime_status"],
      preference: true,
      streaming: false
    })).toMatchObject({ visible: true, requestEnabled: true });

    expect(resolveWebSearchControl({
      modelSupportsTools: true,
      agentAvailable: true,
      agentActive: true,
      tools: ["web_search"],
      preference: true,
      streaming: true
    })).toMatchObject({ visible: true, requestEnabled: true, pressed: true, disabled: true });
  });
});

describe("Source disclosure", () => {
  it("keeps the first row visible and expands only the overflow sources", () => {
    expect(defaultSourcesExpanded(0)).toBe(false);
    expect(defaultSourcesExpanded(1)).toBe(false);
    expect(defaultSourcesExpanded(3)).toBe(false);
    expect(defaultSourcesExpanded(4)).toBe(false);
    expect(defaultSourcesExpanded(12)).toBe(false);
    expect(visibleSourceCount(0)).toBe(0);
    expect(visibleSourceCount(2)).toBe(2);
    expect(visibleSourceCount(7)).toBe(3);
    expect(hiddenSourceCount(2)).toBe(0);
    expect(hiddenSourceCount(7)).toBe(4);
  });

  it("uses one non-clipping card layout for visible and expanded sources", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.message-sources__rail,\s*\.message-sources__grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(styles).not.toMatch(/\.message-sources__rail\s*\{[^}]*overflow-x:\s*auto/);
    expect(styles).toMatch(/\.message-sources__extra\s*\{\s*overflow:\s*visible;\s*\}/);
    expect(styles).toMatch(/\.source-preview-card:hover,\s*\.source-preview-card:focus-visible\s*\{\s*z-index:\s*20;\s*\}/);
  });

  it("loads favicons from the original source origin only", () => {
    expect(sourceFaviconUrl("https://www.example.com/docs/page?x=1")).toBe("https://www.example.com/favicon.ico");
    expect(sourceFaviconUrl("http://localhost:5173/path")).toBe("http://localhost:5173/favicon.ico");
    expect(sourceFaviconUrl("javascript:alert(1)")).toBeNull();
  });

  it("builds a visual screenshot preview URL for safe sources", () => {
    const previewUrl = sourcePreviewImageUrl("https://example.com/docs?x=1");
    expect(previewUrl).not.toBeNull();
    const parsed = new URL(previewUrl!);
    expect(parsed.origin).toBe("https://api.microlink.io");
    expect(parsed.searchParams.get("url")).toBe("https://example.com/docs?x=1");
    expect(parsed.searchParams.get("screenshot")).toBe("true");
    expect(parsed.searchParams.get("embed")).toBe("screenshot.url");
    expect(sourcePreviewImageUrl("mailto:hello@example.com")).toBeNull();
  });
});

describe("Reasoning trace", () => {
  it("rotates collapsed local-thinking phrases deterministically", () => {
    const first = localThinkingPhrase("assistant-1", 0);
    expect(first).toBe(localThinkingPhrase("assistant-1", 0));
    expect(localThinkingPhrase("assistant-1", 2_400)).not.toBe(first);
  });

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
