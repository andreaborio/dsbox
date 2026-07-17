import { describe, expect, it } from "vitest";
import {
  localModelIsRunnable,
  normalizeLocalModelCandidate,
  normalizeLocalModelCandidates,
  normalizeLocalModelScanSnapshot
} from "../src/lib/local-models.js";

describe("local model response normalization", () => {
  it("keeps current compatibility metadata intact", () => {
    const model = normalizeLocalModelCandidate({
      path: "/models/current.gguf",
      name: "current",
      sizeBytes: 42,
      modelId: "current-model",
      selected: true,
      compatibility: { status: "compatible", code: "ds4_native", reason: null },
      architecture: "deepseek4",
      artifactFormat: "ds4-expert-major-v2"
    });

    expect(model).toMatchObject({
      selected: true,
      compatibility: { status: "compatible", code: "ds4_native", reason: null },
      architecture: "deepseek4",
      artifactFormat: "ds4-expert-major-v2"
    });
    expect(model && localModelIsRunnable(model)).toBe(true);
  });

  it("adapts models returned by pre-compatibility DSBox services", () => {
    const model = normalizeLocalModelCandidate({
      path: "/models/legacy.gguf",
      name: "legacy",
      sizeBytes: 128,
      modelId: "legacy-model",
      selected: false
    });

    expect(model).toMatchObject({
      compatibility: {
        status: "unverified",
        code: "legacy_unverified"
      },
      architecture: null,
      artifactFormat: null
    });
    expect(model && localModelIsRunnable(model)).toBe(true);
  });

  it("drops malformed entries and normalizes scan results", () => {
    const models = normalizeLocalModelCandidates([
      null,
      { name: "missing path" },
      { path: "/models/legacy.gguf", name: "legacy", sizeBytes: 1, modelId: "legacy", selected: false }
    ]);
    const scan = normalizeLocalModelScanSnapshot({ status: "complete", models });

    expect(models).toHaveLength(1);
    expect(scan.models[0]?.compatibility.status).toBe("unverified");
  });
});
