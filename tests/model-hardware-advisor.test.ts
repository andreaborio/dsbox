import { describe, expect, it } from "vitest";
import { assessLocalModelHardware, assessModelHardware } from "../src/lib/model-hardware-advisor.js";
import type { CatalogModel } from "../src/types.js";

const GIB = 1024 ** 3;

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    publisher: "andreaborio",
    repository: "andreaborio/deepseek-v4-flash-ds4-metal",
    revision: "a".repeat(40),
    label: "DeepSeek V4 Flash",
    description: "DS4 model",
    modelId: "deepseek-v4-flash",
    runtimeBranch: "main",
    runtimeCommit: "b".repeat(40),
    files: [{ name: "model.gguf", sizeBytes: 90 * GIB, sha256: "c".repeat(64) }],
    outputFile: "model.gguf",
    totalBytes: 90 * GIB,
    recommended: false,
    experimental: false,
    installable: true,
    minimumMemoryGb: null,
    lastModified: null,
    sourceUrl: "https://huggingface.co/andreaborio/model",
    unavailableReason: null,
    variantCount: 1,
    variants: [],
    ...overrides
  };
}

describe("DS4 SSD-streaming hardware advisor", () => {
  it("allows a 90 GB model on a 64 GB Mac and explains SSD streaming", () => {
    const assessment = assessModelHardware(model(), {
      totalMemoryBytes: 64 * GIB,
      diskFreeBytes: 180 * GIB
    });

    expect(assessment.compatibility.status).toBe("verified");
    expect(assessment.performance).toMatchObject({
      level: "ssd-streaming",
      label: "SSD streaming"
    });
    expect(assessment.performance.explanation).toContain("streaming weights from SSD");
    expect(assessment.performance.modelToMemoryRatio).toBeCloseTo(90 / 64);
    expect(assessment.storage.status).toBe("enough");
    expect(assessment.requiresAcknowledgement).toBe(false);
  });

  it("warns but never marks a 90 GB model incompatible on a 16 GB Mac", () => {
    const assessment = assessModelHardware(model({ minimumMemoryGb: 64 }), {
      totalMemoryBytes: 16 * GIB,
      diskFreeBytes: 180 * GIB
    });

    expect(assessment.compatibility.status).toBe("verified");
    expect(assessment.performance.label).toBe("Very slow likely");
    expect(assessment.performance.explanation).toContain("performance warning—not an install limit");
    expect(assessment.storage.status).toBe("enough");
    expect(assessment.requiresAcknowledgement).toBe(true);
  });

  it("uses the recommendation only when published hardware guidance is met", () => {
    const recommended = model({
      totalBytes: 48 * GIB,
      recommended: true,
      minimumMemoryGb: 64,
      files: [{ name: "model.gguf", sizeBytes: 48 * GIB, sha256: "c".repeat(64) }]
    });

    expect(assessModelHardware(recommended, { totalMemoryBytes: 64 * GIB }).performance.label).toBe("Best for this Mac");
    expect(assessModelHardware(recommended, { totalMemoryBytes: 32 * GIB }).performance.label).toBe("May be slow");
  });

  it("accounts for declared architecture without promising a token rate", () => {
    const dense = assessModelHardware(model({ totalBytes: 48 * GIB, architecture: "dense" }), {
      totalMemoryBytes: 16 * GIB
    });
    const moe = assessModelHardware(model({ totalBytes: 48 * GIB, architecture: "moe" }), {
      totalMemoryBytes: 16 * GIB
    });

    expect(dense.performance.label).toBe("Very slow likely");
    expect(moe.performance.label).toBe("May be slow");
    expect(dense.performance.explanation).not.toMatch(/\d+(?:\.\d+)?\s*t\/s/i);
    expect(moe.architecture.source).toBe("catalog");
  });

  it("keeps unknown compatibility and architecture explicit", () => {
    const assessment = assessModelHardware(model({
      runtimeCommit: null,
      runtimeBranch: null,
      files: [{ name: "model.gguf", sizeBytes: 10 * GIB, sha256: null }]
    }), { totalMemoryBytes: 64 * GIB });

    expect(assessment.compatibility).toMatchObject({ status: "unverified", label: "Unverified" });
    expect(assessment.architecture.kind).toBe("unknown");
    expect(assessment.architecture.explanation).toContain("deliberately cautious");
    expect(assessment.requiresAcknowledgement).toBe(true);
  });

  it("treats insufficient disk as a storage block, not a RAM incompatibility", () => {
    const assessment = assessModelHardware(model(), {
      totalMemoryBytes: 16 * GIB,
      diskFreeBytes: 80 * GIB
    });

    expect(assessment.storage).toMatchObject({
      status: "insufficient",
      requiredBytes: 90 * GIB,
      freeBytes: 80 * GIB
    });
    expect(assessment.compatibility.status).toBe("verified");
  });

  it("keeps a verified local DS4 layout separate from its non-blocking performance warning", () => {
    const assessment = assessLocalModelHardware({
      name: "my-model.gguf",
      modelId: "my-model",
      sizeBytes: 90 * GIB,
      architecture: "deepseek4",
      compatibility: { status: "compatible", code: "ds4_native", reason: null }
    }, { totalMemoryBytes: 16 * GIB });

    expect(assessment.performance.label).toBe("Very slow likely");
    expect(assessment.compatibility.label).toBe("Verified for DS4");
    expect(assessment.requiresAcknowledgement).toBe(true);
    expect(assessment.performance.explanation).toContain("DS4 can stream weights from SSD");
  });
});
