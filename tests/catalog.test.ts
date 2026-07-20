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
  it("hides the retired multipart GLM experimental repository", async () => {
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
    expect(catalog.models).toEqual([]);
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
          runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
          file: modelFile,
          artifact: {
            format: {
              id: "ds4-expert-major",
              version: 2,
              tensor: "ds4.expert_major.v2",
              requiresRuntime: "andreaborio/ds4"
            }
          }
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
      runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
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

  it("hides retired repositories while keeping the three consolidated v2 entries", async () => {
    const hiddenRepositories = [
      "andreaborio/DeepSeek-V4-Flash-DS4-ExpertMajor-v2-GGUF",
      "andreaborio/GLM-5.2-DS4-ExpertMajor-v2-GGUF",
      "andreaborio/glm52-ds4-native-64g-q2k-experimental",
      "andreaborio/Qwen3.6-35B-A3B-DS4-ExpertMajor-v1-GGUF",
      "andreaborio/Qwen3.6-35B-A3B-DS4-ExpertMajor-v2-GGUF"
    ];
    const publicRepositories = [
      "andreaborio/DeepSeek-V4-Flash-DS4-GGUF",
      "andreaborio/GLM-5.2-DS4-GGUF",
      "andreaborio/Qwen3.6-35B-A3B-DS4-GGUF"
    ];
    const repositories = [...hiddenRepositories, ...publicRepositories];
    const revisions = new Map(repositories.map((repository, index) => [repository, String(index + 1).repeat(40)]));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) {
        return jsonResponse(repositories.map((id) => ({ id, sha: revisions.get(id) })));
      }
      for (const repository of repositories) {
        const revision = revisions.get(repository)!;
        const isQwen = repository.includes("Qwen3.6");
        const isGlm = repository.toLowerCase().includes("glm");
        const file = isQwen
          ? "Qwen3.6-35B-A3B-DS4-ExpertMajor-v2-Q4_K_S.gguf"
          : isGlm
            ? "GLM-5.2-DS4-ExpertMajor-v2-Q2_K.gguf"
            : "DeepSeek-V4-Flash-DS4-ExpertMajor-v2.gguf";
        if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
          return jsonResponse({
            id: repository,
            sha: revision,
            tags: ["ds4", isQwen ? "qwen3.6" : isGlm ? "glm-5.2" : "deepseek-v4", "expert-major"],
            siblings: [{ rfilename: file, lfs: { size: 2048, sha256: "b".repeat(64) } }]
          });
        }
        if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
          return jsonResponse({
            schemaVersion: 1,
            status: "stable",
            file,
            minimumMemoryGb: 64,
            modelId: isQwen ? "qwen3.6-35b-a3b" : isGlm ? "glm-5.2" : "deepseek-v4-flash",
            runtimeBranch: "main",
            runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
            artifact: {
              format: {
                id: "ds4-expert-major",
                version: 2,
                tensor: "ds4.expert_major.v2",
                requiresRuntime: "andreaborio/ds4"
              }
            }
          });
        }
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.models.map((model) => model.repository).sort()).toEqual([...publicRepositories].sort());
    expect(catalog.models.every((model) =>
      model.artifactFormat === "ds4-expert-major-v2" && model.installable
    )).toBe(true);
  });

  it("exposes a revision-pinned DeepSeek ExpertMajor v2 artifact as DS4-only", async () => {
    const repository = "andreaborio/DeepSeek-V4-Flash-DS4-GGUF";
    const previousRepository = "andreaborio/DeepSeek-V4-Flash-DS4-ExpertMajor-v2-GGUF";
    const revision = "1".repeat(40);
    const nativeFile = "DeepSeek-V4-Flash-DS4-ExpertMajor-v2.gguf";
    const canonicalFile = "DeepSeek-V4-Flash-canonical.gguf";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "deepseek-v4", "experimental", "expert-major"],
          siblings: [
            { rfilename: nativeFile, lfs: { size: 86_720_114_272, sha256: "a".repeat(64) } },
            { rfilename: canonicalFile, lfs: { size: 86_720_111_488, sha256: "b".repeat(64) } }
          ]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          name: "DeepSeek V4 Flash DS4 ExpertMajor v2",
          status: "experimental",
          recommended: false,
          modelId: "deepseek-v4-flash",
          runtimeBranch: "main",
          runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
          file: nativeFile,
          minimumMemoryGb: 64,
          previousRepositories: [previousRepository],
          architecture: "moe",
          artifact: {
            format: {
              id: "ds4-expert-major",
              version: 2,
              tensor: "ds4.expert_major.v2",
              requiresRuntime: "andreaborio/ds4"
            }
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);
    const native = catalog.models.find((model) => model.repository === repository);

    expect(native).toMatchObject({
      artifactFormat: "ds4-expert-major-v2",
      runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
      previousRepositories: [previousRepository],
      outputFile: nativeFile,
      installable: true,
      experimental: true,
      recommended: false,
      variantCount: 1,
      unavailableReason: null
    });
    expect(native?.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ outputFile: nativeFile, installable: true }),
      expect.objectContaining({ outputFile: canonicalFile, installable: false })
    ]));
    expect(catalog.recommended).toBeNull();
  });

  it("exposes the single-file GLM-5.2 ExpertMajor v2 artifact with a 64 GB floor", async () => {
    const repository = "andreaborio/GLM-5.2-DS4-GGUF";
    const previousRepository = "andreaborio/GLM-5.2-DS4-ExpertMajor-v2-GGUF";
    const revision = "7".repeat(40);
    const nativeFile = "GLM-5.2-DS4-ExpertMajor-v2-Q2_K.gguf";
    const runtimeCommit = "fe0919b70571678408f2c8c52aec8d49525e715c";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "glm-5.2", "experimental", "expert-major"],
          siblings: [{
            rfilename: nativeFile,
            lfs: { size: 262_147_193_504, sha256: "9".repeat(64) }
          }]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          name: "GLM-5.2 DS4 ExpertMajor v2 Q2_K",
          status: "experimental",
          recommended: false,
          modelId: "glm-5.2",
          runtimeBranch: "main",
          runtimeCommit,
          file: nativeFile,
          minimumMemoryGb: 64,
          previousRepositories: [previousRepository],
          architecture: "moe",
          artifact: {
            format: {
              id: "ds4-expert-major",
              version: 2,
              tensor: "ds4.expert_major.v2",
              requiresRuntime: "andreaborio/ds4"
            }
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);
    const native = catalog.models.find((model) => model.repository === repository);

    expect(native).toMatchObject({
      modelId: "glm-5.2",
      artifactFormat: "ds4-expert-major-v2",
      runtimeCommit,
      outputFile: nativeFile,
      minimumMemoryGb: 64,
      previousRepositories: [previousRepository],
      totalBytes: 262_147_193_504,
      installable: true,
      experimental: true,
      recommended: false,
      variantCount: 1,
      unavailableReason: null
    });
    expect(catalog.recommended).toBeNull();
  });

  it("selects only Qwen v2 from the consolidated public repository", async () => {
    const repository = "andreaborio/Qwen3.6-35B-A3B-DS4-GGUF";
    const previousRepository = "andreaborio/Qwen3.6-35B-A3B-DS4-ExpertMajor-v1-GGUF";
    const revision = "2".repeat(40);
    const canonicalFile = "Qwen3.6-35B-A3B-ds4-Q4_K_S.gguf";
    const v1File = "Qwen3.6-35B-A3B-DS4-ExpertMajor-v1-Q4_K_S.gguf";
    const modelFile = "Qwen3.6-35B-A3B-DS4-ExpertMajor-v2-Q4_K_S.gguf";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "qwen3.6", "expert-major"],
          siblings: [
            { rfilename: canonicalFile, lfs: { size: 20_808_563_424, sha256: "a".repeat(64) } },
            { rfilename: v1File, lfs: { size: 20_808_970_240, sha256: "b".repeat(64) } },
            { rfilename: modelFile, lfs: { size: 20_808_566_880, sha256: "c".repeat(64) } }
          ]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          status: "stable",
          recommended: true,
          modelId: "qwen3.6-35b-a3b",
          runtimeBranch: "main",
          runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
          file: modelFile,
          minimumMemoryGb: 64,
          previousRepositories: [previousRepository, null, 42, "not a repository", previousRepository],
          artifact: {
            format: {
              id: "ds4-expert-major",
              version: 2,
              tensor: "ds4.expert_major.v2",
              requiresRuntime: "andreaborio/ds4"
            }
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);
    const qwen = catalog.models.find((model) => model.repository === repository);

    expect(qwen).toMatchObject({
      artifactFormat: "ds4-expert-major-v2",
      previousRepositories: [previousRepository],
      installable: true,
      recommended: true,
      outputFile: modelFile,
      variantCount: 1
    });
    expect(qwen?.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ outputFile: canonicalFile, installable: false }),
      expect.objectContaining({ outputFile: v1File, installable: false }),
      expect.objectContaining({ outputFile: modelFile, installable: true })
    ]));
    expect(catalog.recommended?.repository).toBe(repository);
  });

  it("refuses an ExpertMajor-named repository without the explicit DS4-only format contract", async () => {
    const repository = "andreaborio/DeepSeek-V4-Flash-DS4-Lab-ExpertMajor-v2-GGUF";
    const revision = "3".repeat(40);
    const modelFile = "DeepSeek-V4-Flash-DS4-ExpertMajor-v2.gguf";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url.includes(`/api/models/${repository}/revision/${revision}`)) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "experimental"],
          siblings: [{ rfilename: modelFile, lfs: { size: 1024, sha256: "d".repeat(64) } }]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          status: "experimental",
          modelId: "deepseek-v4-flash",
          runtimeBranch: "main",
          runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
          file: modelFile,
          minimumMemoryGb: 64
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.models.find((model) => model.repository === repository)).toMatchObject({
      artifactFormat: null,
      installable: false,
      recommended: false,
      unavailableReason: "The ds4-expert-major-v2 repository must declare its DS4-only artifact format in dsbox.json"
    });
  });

  it("refuses unknown ExpertMajor versions instead of treating them as generic GGUF", async () => {
    const repository = "andreaborio/DeepSeek-V4-Flash-DS4-ExpertMajor-v3-GGUF";
    const revision = "4".repeat(40);
    const modelFile = "DeepSeek-V4-Flash-DS4-ExpertMajor-v3.gguf";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url.includes(`/api/models/${repository}/revision/${revision}`)) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "experimental", "expert-major"],
          siblings: [{ rfilename: modelFile, lfs: { size: 1024, sha256: "e".repeat(64) } }]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          status: "experimental",
          modelId: "deepseek-v4-flash",
          runtimeBranch: "main",
          runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
          file: modelFile,
          minimumMemoryGb: 64
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.models.find((model) => model.repository === repository)).toMatchObject({
      installable: false,
      artifactFormat: null,
      unavailableReason: "DSBox does not support DS4 ExpertMajor v3"
    });
  });

  it("blocks an ExpertMajor file per variant inside an otherwise generic repository", async () => {
    const repository = "andreaborio/mixed-deepseek-builds";
    const revision = "5".repeat(40);
    const canonicalFile = "deepseek-canonical.gguf";
    const unknownNativeFile = "deepseek-DS4-ExpertMajor-v3.gguf";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "deepseek-v4"],
          siblings: [
            { rfilename: canonicalFile, lfs: { size: 1024, sha256: "a".repeat(64) } },
            { rfilename: unknownNativeFile, lfs: { size: 1025, sha256: "b".repeat(64) } }
          ]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({ error: "not found" }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);
    const model = catalog.models.find((candidate) => candidate.repository === repository);

    expect(model).toMatchObject({
      installable: false,
      artifactFormat: null,
      variantCount: 2,
      unavailableReason: "deepseek-v4-flash requires a manifest-pinned DS4 ExpertMajor v2 artifact"
    });
    expect(model?.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outputFile: canonicalFile,
        installable: false,
        unavailableReason: "deepseek-v4-flash requires a manifest-pinned DS4 ExpertMajor v2 artifact"
      }),
      expect.objectContaining({
        outputFile: unknownNativeFile,
        installable: false,
        unavailableReason: "deepseek-v4-flash requires a manifest-pinned DS4 ExpertMajor v2 artifact"
      })
    ]));
  });

  it("requires the ExpertMajor manifest version to be an exact JSON integer", async () => {
    const repository = "andreaborio/DeepSeek-V4-Flash-DS4-Lab-ExpertMajor-v2-GGUF";
    const revision = "6".repeat(40);
    const modelFile = "DeepSeek-V4-Flash-DS4-ExpertMajor-v2.gguf";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("/api/models?")) return jsonResponse([{ id: repository, sha: revision }]);
      if (url === `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`) {
        return jsonResponse({
          id: repository,
          sha: revision,
          tags: ["ds4", "experimental"],
          siblings: [{ rfilename: modelFile, lfs: { size: 1024, sha256: "c".repeat(64) } }]
        });
      }
      if (url === `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`) {
        return jsonResponse({
          schemaVersion: 1,
          status: "experimental",
          modelId: "deepseek-v4-flash",
          runtimeBranch: "main",
          runtimeCommit: "fe0919b70571678408f2c8c52aec8d49525e715c",
          file: modelFile,
          minimumMemoryGb: 64,
          artifact: {
            format: {
              id: "ds4-expert-major",
              version: "2",
              tensor: "ds4.expert_major.v2",
              requiresRuntime: "andreaborio/ds4"
            }
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.models.find((model) => model.repository === repository)).toMatchObject({
      installable: false,
      artifactFormat: null,
      unavailableReason: "The DSBox manifest declares an unknown DS4 artifact format"
    });
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
    const repositories = ["unsloth/DeepSeek-V4-Flash-GGUF", "unsloth/GLM-5.2-GGUF", "unsloth/Qwen3.6-35B-A3B-GGUF"];
    const revisions = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      if (url.includes("author=andreaborio")) return jsonResponse([]);
      for (let index = 0; index < repositories.length; index += 1) {
        const repository = repositories[index];
        const revision = revisions[index];
        const model = {
          id: repository,
          sha: revision,
          tags: index === 0 ? ["gguf", "deepseek_v4"] : index === 1 ? ["gguf", "glm-5.2"] : ["gguf", "qwen3.6", "moe"],
          siblings: index === 0
            ? [
                { rfilename: "UD-IQ1_M/model-00001-of-00002.gguf", lfs: { size: 10, sha256: "a".repeat(64) } },
                { rfilename: "UD-IQ1_M/model-00002-of-00002.gguf", lfs: { size: 20, sha256: "b".repeat(64) } },
                { rfilename: "UD-IQ2_XXS/model-00001-of-00002.gguf", lfs: { size: 11, sha256: "c".repeat(64) } },
                { rfilename: "UD-IQ2_XXS/model-00002-of-00002.gguf", lfs: { size: 21, sha256: "d".repeat(64) } }
              ]
            : index === 1 ? [
                { rfilename: "UD-IQ1_S/model-00001-of-00002.gguf", lfs: { size: 30, sha256: "e".repeat(64) } },
                { rfilename: "UD-IQ1_S/model-00002-of-00002.gguf", lfs: { size: 40, sha256: "f".repeat(64) } }
              ]
            : [
                { rfilename: "Qwen3.6-35B-A3B-UD-Q4_K_S.gguf", lfs: { size: 20_893_015_008, sha256: "a8138f183e3993f12cdc23afd2babb8cdb084e64088ce4a256d49101d47b949c" } }
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
    expect(catalog.models).toHaveLength(3);
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
    expect(catalog.models.find((model) => model.repository === repositories[2])).toMatchObject({
      publisher: "unsloth",
      label: "Qwen3.6 35B A3B",
      modelId: "qwen3.6-35b-a3b",
      installable: false,
      recommended: false,
      architecture: "moe",
      unavailableReason: "DS4 requires the normalized Qwen3.6 DS4 artifact; these source GGUF files are not directly runnable"
    });
    expect(catalog.recommended).toBeNull();
  });

  it("removes the canonical antirez source from the catalog", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = requestedUrl(input);
      urls.push(url);
      if (url.includes("author=andreaborio")) return jsonResponse([]);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const catalog = await new ModelCatalog().list(64 * 1024 ** 3, true);

    expect(catalog.sources.map((source) => source.id)).toEqual(["andreaborio", "unsloth"]);
    expect(catalog.models).toEqual([]);
    expect(catalog.recommended).toBeNull();
    expect(urls.some((url) => url.includes("antirez/deepseek-v4-gguf"))).toBe(false);
  });
});
