import { describe, expect, it } from "vitest";
import { formatModelName } from "../src/lib/format.js";

describe("model name formatting", () => {
  it("formats common Qwen model ids for compact UI surfaces", () => {
    expect(formatModelName("qwen3-30b-a3b")).toBe("Qwen3 30B A3B");
    expect(formatModelName("qwen3.6-35b-a3b")).toBe("Qwen3.6 35B A3B");
    expect(formatModelName("qwen2.5-coder-32b-instruct")).toBe("Qwen2.5 Coder 32B Instruct");
    expect(formatModelName("Qwen3.5-397B-A17B")).toBe("Qwen3.5 397B A17B");
    expect(formatModelName("qwen3-5-397b-a17b")).toBe("Qwen3.5 397B A17B");
  });

  it("preserves unknown model ids", () => {
    expect(formatModelName("custom-model-v1")).toBe("custom-model-v1");
  });
});
