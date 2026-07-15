import { describe, expect, it } from "vitest";
import { getQwenAdapterCompatibility, resolveQwenAdapter, type AgentAdapterId } from "../src/lib/agent-adapters.js";

describe("Qwen agent adapter compatibility", () => {
  it.each([
    ["codex", false, "Requires Responses API"],
    ["claude", false, "Requires Anthropic Messages"],
    ["opencode", true, null],
    ["pi", true, null],
    ["generic", true, null]
  ] as const)("classifies %s by its wire protocol", (adapter, available, unavailableReason) => {
    expect(getQwenAdapterCompatibility(adapter as AgentAdapterId)).toEqual({ available, unavailableReason });
  });

  it.each([
    ["codex", "generic"],
    ["claude", "generic"],
    ["opencode", "opencode"],
    ["pi", "pi"],
    ["generic", "generic"]
  ] as const)("resolves %s to %s when Qwen becomes active", (adapter, expected) => {
    expect(resolveQwenAdapter(adapter)).toBe(expected);
  });
});
