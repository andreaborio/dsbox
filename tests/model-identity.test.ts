import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { identifyModel } from "../src/lib/model-identity.js";

describe("model identity", () => {
  it.each([
    ["deepseek", ["deepseek-v4-flash", "DeepSeek V4 Flash"]],
    ["qwen", ["qwen3.6-35b-a3b", "/Models/Qwen3.6-35B-A3B-Q4.gguf"]],
    ["glm", ["glm-5.2", "unsloth/GLM-5.2-GGUF"]]
  ] as const)("recognizes %s from model metadata", (expected, signals) => {
    expect(identifyModel(...signals)).toBe(expected);
  });

  it("keeps unknown model families neutral", () => {
    expect(identifyModel("llama-3.3", "/Models/llama.gguf")).toBe("generic");
    expect(identifyModel("deepseeker", "qwenish", "glmware")).toBe("generic");
  });

  it("bundles the byte-identical Qwen mark published by qwen.ai", () => {
    const svg = readFileSync(new URL("../src/assets/model-identities/qwen.svg", import.meta.url), "utf8");
    const payload = svg.match(/base64,([^"<]+)/)?.[1];
    expect(payload).toBeTruthy();
    expect(createHash("sha256").update(Buffer.from(payload!, "base64")).digest("hex"))
      .toBe("ea19f2ff6fc749ebd4fd9d7df3365d83ee333c2fd04a04596044ed3a09f4976d");
  });
});
