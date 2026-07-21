import { describe, expect, it } from "vitest";
import { catalogModelIsReady, chooseDefaultCatalogVariant, installableCatalogVariants } from "../src/lib/model-variants.js";
import type { CatalogModel, CatalogModelVariant } from "../src/types.js";

const GIB = 1024 ** 3;

function variant(id: string, sizeGb: number, installable = true): CatalogModelVariant {
  return {
    id,
    label: id,
    files: [{ name: `${id}.gguf`, sizeBytes: sizeGb * GIB, sha256: null }],
    outputFile: `${id}.gguf`,
    totalBytes: sizeGb * GIB,
    installable,
    unavailableReason: installable ? null : "Incomplete",
    assembly: null
  };
}

function model(variants: CatalogModelVariant[]): CatalogModel {
  return {
    publisher: "unsloth",
    repository: "unsloth/DeepSeek-V4-Flash-GGUF",
    revision: "a".repeat(40),
    label: "DeepSeek V4 Flash",
    description: "Model",
    modelId: "deepseek-v4-flash",
    runtimeBranch: null,
    runtimeCommit: null,
    files: [],
    outputFile: null,
    totalBytes: 0,
    recommended: false,
    experimental: false,
    installable: true,
    minimumMemoryGb: null,
    lastModified: null,
    sourceUrl: "https://huggingface.co/unsloth/model",
    unavailableReason: null,
    variantCount: variants.length,
    variants
  };
}

describe("catalog variant defaults", () => {
  it("chooses the largest variant within the SSD-streaming target", () => {
    const selected = chooseDefaultCatalogVariant(model([
      variant("small", 70),
      variant("balanced", 90),
      variant("large", 130)
    ]), 64 * GIB);

    expect(selected?.id).toBe("balanced");
  });

  it("falls back to the smallest complete variant on constrained hardware", () => {
    const selected = chooseDefaultCatalogVariant(model([
      variant("incomplete", 12, false),
      variant("smallest", 70),
      variant("larger", 90)
    ]), 16 * GIB);

    expect(selected?.id).toBe("smallest");
    expect(installableCatalogVariants(model([variant("bad", 4, false)]))).toEqual([]);
  });

  it("marks only catalog entries with an enabled complete variant as ready", () => {
    expect(catalogModelIsReady(model([variant("ready", 70)]), 16 * GIB)).toBe(true);
    expect(catalogModelIsReady(model([variant("incomplete", 70, false)]), 16 * GIB)).toBe(false);
    expect(catalogModelIsReady({ ...model([variant("complete", 70)]), installable: false }, 16 * GIB)).toBe(false);
  });

  it("enforces the catalog publisher memory floor", () => {
    const releaseModel = { ...model([variant("release", 70)]), minimumMemoryGb: 64 };
    expect(catalogModelIsReady(releaseModel, 64 * GIB)).toBe(true);
    expect(catalogModelIsReady(releaseModel, 32 * GIB)).toBe(false);
  });
});
