import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalog } from "../server/catalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function requestedUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hugging Face model catalog", () => {
  it("groups a current-style multipart model for in-app download without recommending experimental builds", async () => {
    const repository = "andreaborio/glm52-ds4-native-64g-q2k-experimental";
    const revision = "696c749dada98815931d8f704e4ba1f1fdfeb5a7";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) {
        return jsonResponse([{ id: repository, sha: revision }]);
      }
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "glm-5.2", "experimental"],
          siblings: [
            { rfilename: "model.gguf.part-01", lfs: { size: 120, sha256: "part-one" } },
            { rfilename: "model.gguf.part-02", lfs: { size: 124, sha256: "part-two" } }
          ]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({ error: "not found" }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.recommended).toBeNull();
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      repository,
      revision,
      label: "GLM 5.2 DS4 Native 64 GB Q2_K Experimental",
      experimental: true,
      installable: true,
      recommended: false,
      outputFile: "model.gguf",
      totalBytes: 244,
      unavailableReason: null,
      variantCount: 1
    });
    expect(catalog.models[0].files.map((file) => file.name)).toEqual([
      "model.gguf.part-01",
      "model.gguf.part-02"
    ]);
    expect(catalog.models[0].variants[0]).toMatchObject({
      installable: true,
      outputFile: "model.gguf",
      totalBytes: 244,
      assembly: { type: "concatenate", outputFile: "model.gguf" }
    });
  });

  it("recommends a compatible stable single-GGUF manifest and pins every lookup to its revision", async () => {
    const repository = "andreaborio/deepseek-v4-flash-ds4-metal";
    const revision = "0123456789abcdef0123456789abcdef01234567";
    const modelFile = "deepseek-v4-flash-q2_k.gguf";
    const modelSha256 = "c".repeat(64);
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      urls.push(url);
      if (url.includes("/api/models?")) {
        return jsonResponse([{ id: repository, sha: revision }]);
      }
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          lastModified: "2026-07-12T10:00:00.000Z",
          tags: ["ds4", "deepseek-v4"],
          siblings: [
            { rfilename: "dsbox.json", size: 512 },
            { rfilename: modelFile, lfs: { size: 48 * 1024 ** 3, sha256: modelSha256 } }
          ]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          name: "DeepSeek V4 Flash for DSBox",
          description: "Metal and SSD streaming profile verified by DSBox.",
          status: "stable",
          recommended: true,
          minimumMemoryGb: 64,
          modelId: "deepseek-v4-flash",
          runtimeBranch: "main",
          runtimeCommit: "d".repeat(40),
          file: modelFile
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.stale).toBe(false);
    expect(catalog.recommended).toMatchObject({
      repository,
      revision,
      label: "DeepSeek V4 Flash for DSBox",
      runtimeBranch: "main",
      runtimeCommit: "d".repeat(40),
      outputFile: modelFile,
      installable: true,
      experimental: false,
      recommended: true,
      minimumMemoryGb: 64
    });
    expect(catalog.recommended?.files).toEqual([{
      name: modelFile,
      sizeBytes: 48 * 1024 ** 3,
      sha256: modelSha256
    }]);
    expect(urls).toContain(`https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`);
    expect(urls).toContain(`https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`);
    expect(urls.filter((url) => url.includes(repository))).toSatisfy(
      (repositoryUrls: string[]) => repositoryUrls.every((url) => url.includes(revision))
    );
  });

  it("never labels an experimental model as recommended even with a stable manifest", async () => {
    const repository = "andreaborio/labs-model-experimental";
    const revision = "fedcba9876543210fedcba9876543210fedcba98";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url.includes(`/api/models/${repository}/revision/${revision}`)) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "experimental"],
          siblings: [{ rfilename: "labs.gguf", lfs: { size: 1024 } }]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          status: "stable",
          recommended: true,
          file: "labs.gguf"
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await new ModelCatalog().list(128 * 1024 ** 3, true);

    expect(catalog.models[0]).toMatchObject({
      modelId: "labs-model-experimental",
      experimental: true,
      installable: true,
      recommended: false
    });
    expect(catalog.recommended).toBeNull();
  });

  it("requires explicit hardware and runtime compatibility before recommending a model", async () => {
    const repository = "andreaborio/incomplete-stable-model";
    const revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url.includes(`/api/models/${repository}/revision/${revision}`)) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4"],
          siblings: [{ rfilename: "model.gguf", lfs: { size: 1024 } }]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({ schemaVersion: 1, status: "stable", recommended: true, file: "model.gguf" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(128 * 1024 ** 3, true);

    expect(catalog.models[0]).toMatchObject({ installable: true, recommended: false, minimumMemoryGb: null });
    expect(catalog.recommended).toBeNull();
  });

  it("does not substitute another GGUF when the manifest names a missing file", async () => {
    const repository = "andreaborio/broken-manifest-model";
    const revision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url.includes(`/api/models/${repository}/revision/${revision}`)) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4"],
          siblings: [{ rfilename: "other.gguf", lfs: { size: 1024, sha256: "abc" } }]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          status: "stable",
          recommended: true,
          file: "missing.gguf",
          minimumMemoryGb: 64,
          modelId: "broken",
          runtimeBranch: "main"
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(128 * 1024 ** 3, true);

    expect(catalog.models[0]).toMatchObject({
      installable: false,
      recommended: false,
      outputFile: null,
      unavailableReason: "The manifest references a missing file: missing.gguf"
    });
  });

  it("keeps standard Unsloth GGUF repositories visible but prevents incompatible DS4 downloads", async () => {
    const repositories = ["unsloth/DeepSeek-V4-Flash-GGUF", "unsloth/GLM-5.2-GGUF"];
    const revisions = ["1".repeat(40), "2".repeat(40)];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("author=andreaborio")) return jsonResponse([]);
      for (let index = 0; index < repositories.length; index += 1) {
        const repository = repositories[index];
        const revision = revisions[index];
        const model = {
          id: repository,
          sha: revision,
          tags: index === 0 ? ["gguf", "deepseek_v4"] : ["gguf", "glm-5.2"],
          siblings: index === 0
            ? [
                { rfilename: "UD-IQ1_M/model-00001-of-00002.gguf", lfs: { size: 10, sha256: "a".repeat(64) } },
                { rfilename: "UD-IQ1_M/model-00002-of-00002.gguf", lfs: { size: 20, sha256: "b".repeat(64) } },
                { rfilename: "UD-IQ2_XXS/model-00001-of-00002.gguf", lfs: { size: 11, sha256: "c".repeat(64) } },
                { rfilename: "UD-IQ2_XXS/model-00002-of-00002.gguf", lfs: { size: 21, sha256: "d".repeat(64) } }
              ]
            : [
                { rfilename: "UD-IQ1_S/model-00001-of-00002.gguf", lfs: { size: 30, sha256: "e".repeat(64) } },
                { rfilename: "UD-IQ1_S/model-00002-of-00002.gguf", lfs: { size: 40, sha256: "f".repeat(64) } }
              ]
        };
        if (url === `https://huggingface.co/api/models/${repository}?blobs=true`
          || url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
          return jsonResponse(model);
        }
        if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
          return jsonResponse({ error: "not found" }, 404);
        }
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.sources).toContainEqual({
      id: "unsloth",
      label: "Unsloth",
      url: "https://huggingface.co/unsloth/models"
    });
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models.find((model) => model.repository === repositories[0])).toMatchObject({
      publisher: "unsloth",
      label: "DeepSeek V4 Flash",
      modelId: "deepseek-v4-flash",
      variantCount: 2,
      installable: false,
      recommended: false,
      sourceUrl: `https://huggingface.co/${repositories[0]}/tree/${revisions[0]}`,
      unavailableReason: "DS4 does not support standard multi-file GGUF sets"
    });
    expect(catalog.models.find((model) => model.repository === repositories[0])?.variants).toMatchObject([
      { label: "UD IQ1 M", totalBytes: 30, installable: false, unavailableReason: "DS4 does not support standard multi-file GGUF sets", files: [{ sizeBytes: 10 }, { sizeBytes: 20 }] },
      { label: "UD IQ2 XXS", totalBytes: 32, installable: false, unavailableReason: "DS4 does not support standard multi-file GGUF sets", files: [{ sizeBytes: 11 }, { sizeBytes: 21 }] }
    ]);
    expect(catalog.models.find((model) => model.repository === repositories[1])).toMatchObject({
      publisher: "unsloth",
      label: "GLM 5.2",
      modelId: "glm-5.2",
      variantCount: 1,
      installable: false,
      recommended: false,
      totalBytes: 70,
      outputFile: "UD-IQ1_S/model-00001-of-00002.gguf",
      unavailableReason: "DS4 does not support standard multi-file GGUF sets"
    });
    expect(catalog.recommended).toBeNull();
  });

  it("offers only the checksum-pinned DS4-native DwarfStar model for one-click download", async () => {
    const repository = "antirez/deepseek-v4-gguf";
    const revision = "9170bf42beb77f38006e016503ecace31f2bd9a0";
    const modelFile = "DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf";
    const modelSha256 = "efc7ed607ff27076e3e501fc3fefefa33c0ed8cf1eff483a2b7fdc0c2e616668";
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      urls.push(url);
      if (url.includes("author=andreaborio")) return jsonResponse([]);
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          lastModified: "2026-05-31T11:28:43.000Z",
          siblings: [
            { rfilename: modelFile, lfs: { size: 86_720_111_488, sha256: modelSha256 } },
            { rfilename: "unverified-alternative.gguf", lfs: { size: 12, sha256: "a".repeat(64) } }
          ]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.sources).toContainEqual({
      id: "antirez",
      label: "DwarfStar",
      url: "https://huggingface.co/antirez/deepseek-v4-gguf"
    });
    expect(catalog.recommended).toMatchObject({
      publisher: "antirez",
      repository,
      revision,
      label: "DeepSeek V4 Flash Q2 Imatrix",
      modelId: "deepseek-v4-flash",
      runtimeBranch: "main",
      runtimeCommit: "1523b2681eefaf2688fc98be3fe629641ac314b0",
      minimumMemoryGb: 64,
      architecture: "moe",
      installable: true,
      recommended: true,
      outputFile: modelFile,
      totalBytes: 86_720_111_488,
      variantCount: 1,
      unavailableReason: null,
      sourceUrl: `https://huggingface.co/${repository}/tree/${revision}`
    });
    expect(catalog.recommended?.files).toEqual([{
      name: modelFile,
      sizeBytes: 86_720_111_488,
      sha256: modelSha256
    }]);
    expect(catalog.recommended?.variants).toHaveLength(1);
    expect(catalog.recommended?.variants[0]?.files).toHaveLength(1);
    expect(urls.filter((url) => url.includes(repository))).toEqual([
      `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`
    ]);
  });

  it("does not expose the trusted model if Hugging Face metadata differs from its pin", async () => {
    const repository = "antirez/deepseek-v4-gguf";
    const revision = "9170bf42beb77f38006e016503ecace31f2bd9a0";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("author=andreaborio")) return jsonResponse([]);
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          siblings: [{
            rfilename: "DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf",
            lfs: { size: 86_720_111_488, sha256: "0".repeat(64) }
          }]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.models).toEqual([]);
    expect(catalog.recommended).toBeNull();
    expect(catalog.stale).toBe(false);
  });
});
