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
  it("keeps the current-style experimental multipart model out of one-click recommendations", async () => {
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
      installable: false,
      recommended: false,
      outputFile: null,
      totalBytes: 244,
      unavailableReason: "Pubblicato in più parti: installazione manuale richiesta"
    });
    expect(catalog.models[0].files.map((file) => file.name)).toEqual([
      "model.gguf.part-01",
      "model.gguf.part-02"
    ]);
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
          name: "DeepSeek V4 Flash per DSBox",
          description: "Profilo Metal e SSD streaming verificato da DSBox.",
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
      label: "DeepSeek V4 Flash per DSBox",
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

    expect(catalog.models[0]).toMatchObject({ experimental: true, installable: true, recommended: false });
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
      unavailableReason: "Il manifest indica un file assente: missing.gguf"
    });
  });
});
