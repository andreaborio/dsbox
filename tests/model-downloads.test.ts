import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogModel, CatalogModelVariant, ModelDownloadSnapshot, ServerEvent } from "../src/types.js";
import { ConfigStore } from "../server/config.js";
import { EventBus } from "../server/event-bus.js";
import { ModelDownloadManager } from "../server/model-downloads.js";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function catalogModel(variant: CatalogModelVariant): CatalogModel {
  return {
    publisher: "unsloth",
    repository: "unsloth/Test-Model-GGUF",
    revision: "a".repeat(40),
    label: "Test model",
    description: "Test model",
    modelId: "test-model",
    runtimeBranch: null,
    runtimeCommit: null,
    files: variant.files,
    outputFile: variant.outputFile,
    totalBytes: variant.totalBytes,
    recommended: false,
    experimental: false,
    installable: true,
    minimumMemoryGb: null,
    lastModified: null,
    sourceUrl: "https://huggingface.co/unsloth/Test-Model-GGUF",
    unavailableReason: null,
    variantCount: 1,
    variants: [variant]
  };
}

async function waitForDownload(
  manager: ModelDownloadManager,
  id: string,
  predicate: (snapshot: ModelDownloadSnapshot) => boolean,
  timeoutMs = 5_000
): Promise<ModelDownloadSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = manager.get(id);
    if (predicate(snapshot)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for download ${id}: ${JSON.stringify(manager.get(id))}`);
}

describe("transparent Hugging Face downloads", () => {
  let home: string;
  let store: ConfigStore;
  let bus: EventBus;
  let server: Server;
  let baseUrl: string;
  let files: Map<string, Buffer>;
  let requestedRanges: string[];
  let slowResponses: boolean;
  let managers: ModelDownloadManager[];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "dsbox-downloads-"));
    process.env.DSBOX_HOME = home;
    store = await ConfigStore.open(64 * 1024 ** 3);
    bus = new EventBus();
    files = new Map();
    requestedRanges = [];
    slowResponses = false;
    managers = [];
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const marker = `/resolve/${"a".repeat(40)}/`;
      const markerIndex = requestUrl.pathname.indexOf(marker);
      const filename = markerIndex >= 0
        ? decodeURIComponent(requestUrl.pathname.slice(markerIndex + marker.length))
        : "";
      const data = files.get(filename);
      if (!data) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("accept-ranges", "bytes");
      response.setHeader("x-linked-size", String(data.length));
      response.setHeader("x-linked-etag", sha256(data));
      if (request.method === "HEAD") {
        response.setHeader("content-length", String(data.length));
        response.end();
        return;
      }
      const range = request.headers.range ?? "";
      requestedRanges.push(range);
      const start = Number(String(range).match(/^bytes=(\d+)-$/)?.[1] ?? 0);
      if (start >= data.length) {
        response.statusCode = 416;
        response.end();
        return;
      }
      if (start > 0) {
        response.statusCode = 206;
        response.setHeader("content-range", `bytes ${start}-${data.length - 1}/${data.length}`);
      }
      const body = data.subarray(start);
      response.setHeader("content-length", String(body.length));
      if (!slowResponses) {
        response.end(body);
        return;
      }
      let offset = 0;
      const send = () => {
        if (response.destroyed) return;
        const chunk = body.subarray(offset, Math.min(offset + 16 * 1024, body.length));
        offset += chunk.length;
        response.write(chunk);
        if (offset >= body.length) response.end();
        else setTimeout(send, 8);
      };
      send();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const downloads of managers) {
      for (const snapshot of downloads.list()) {
        await downloads.cancel(snapshot.id);
      }
    }
    delete process.env.DSBOX_HOME;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  async function manager(options: { diskFreeBytes?: number } = {}): Promise<ModelDownloadManager> {
    const downloads = await ModelDownloadManager.open(store, bus, {
      hubBaseUrl: baseUrl,
      retryDelayMs: 1,
      getDiskFreeBytes: async () => options.diskFreeBytes ?? 100 * 1024 ** 3
    });
    managers.push(downloads);
    return downloads;
  }

  it("isolates concurrent atomic state writes across manager instances", async () => {
    const managers = await Promise.all(Array.from({ length: 8 }, () => manager()));
    const persist = (downloads: ModelDownloadManager) => (
      downloads as unknown as { persist(): Promise<void> }
    ).persist();

    await expect(Promise.all(
      Array.from({ length: 64 }, (_, index) => persist(managers[index % managers.length]))
    )).resolves.toHaveLength(64);

    const state = JSON.parse(await readFile(path.join(home, "downloads", "state.json"), "utf8"));
    expect(state).toEqual({ version: 1, downloads: [] });
  });

  it("downloads and transactionally installs every standard GGUF shard", async () => {
    const first = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64, 1)]);
    const second = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(80, 2)]);
    files.set("UD-IQ1_M/model-00001-of-00002.gguf", first);
    files.set("UD-IQ1_M/model-00002-of-00002.gguf", second);
    const variant: CatalogModelVariant = {
      id: "variant-sharded",
      label: "UD IQ1 M",
      files: [
        { name: "UD-IQ1_M/model-00001-of-00002.gguf", sizeBytes: first.length, sha256: sha256(first) },
        { name: "UD-IQ1_M/model-00002-of-00002.gguf", sizeBytes: second.length, sha256: sha256(second) }
      ],
      outputFile: "UD-IQ1_M/model-00001-of-00002.gguf",
      totalBytes: first.length + second.length,
      installable: true,
      unavailableReason: null,
      assembly: null
    };
    const progressEvents: ModelDownloadSnapshot[] = [];
    bus.on("event", (event: ServerEvent) => {
      if (event.type === "download") progressEvents.push(event.payload);
    });
    const downloads = await manager();
    const started = await downloads.start(catalogModel(variant), variant.id);
    const ready = await waitForDownload(downloads, started.id, (snapshot) => snapshot.stage === "ready");

    expect(await readFile(path.join(ready.destinationDirectory, variant.files[0].name))).toEqual(first);
    expect(await readFile(path.join(ready.destinationDirectory, variant.files[1].name))).toEqual(second);
    expect(store.get().model).toEqual({
      path: path.join(ready.destinationDirectory, variant.outputFile),
      id: "test-model"
    });
    expect(ready).toMatchObject({
      totalBytes: first.length + second.length,
      downloadedBytes: first.length + second.length,
      etaSeconds: 0,
      error: null
    });
    expect(progressEvents.some((snapshot) => snapshot.downloadedBytes > 0)).toBe(true);
    expect(requestedRanges).toEqual(["", ""]);
  });

  it("persists a stopped partial and resumes it with an HTTP range after restart", async () => {
    slowResponses = true;
    const data = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(512 * 1024, 7)]);
    files.set("large.gguf", data);
    const variant: CatalogModelVariant = {
      id: "variant-resume",
      label: "Q2 K",
      files: [{ name: "large.gguf", sizeBytes: data.length, sha256: sha256(data) }],
      outputFile: "large.gguf",
      totalBytes: data.length,
      installable: true,
      unavailableReason: null,
      assembly: null
    };
    const firstManager = await manager();
    const started = await firstManager.start(catalogModel(variant), variant.id);
    await waitForDownload(firstManager, started.id, (snapshot) => snapshot.downloadedBytes >= 32 * 1024);
    const paused = await firstManager.cancel(started.id);
    expect(paused.stage).toBe("paused");
    expect(paused.downloadedBytes).toBeGreaterThan(0);
    expect(paused.downloadedBytes).toBeLessThan(data.length);

    const restoredManager = await manager();
    const restored = restoredManager.get(started.id);
    expect(restored).toMatchObject({ stage: "paused", downloadedBytes: paused.downloadedBytes });
    await restoredManager.resume(started.id);
    const ready = await waitForDownload(restoredManager, started.id, (snapshot) => snapshot.stage === "ready");

    expect(await readFile(path.join(ready.destinationDirectory, "large.gguf"))).toEqual(data);
    expect(requestedRanges.some((range) => /^bytes=[1-9]\d*-$/.test(range))).toBe(true);
  });

  it("assembles .gguf.part files as one streamed transaction without retaining duplicate parts", async () => {
    const first = Buffer.from("GGUF-first-part");
    const second = Buffer.from("-second-part");
    files.set("model.gguf.part-01", first);
    files.set("model.gguf.part-02", second);
    const variant: CatalogModelVariant = {
      id: "variant-assembly",
      label: "Q2 K",
      files: [
        { name: "model.gguf.part-01", sizeBytes: first.length, sha256: sha256(first) },
        { name: "model.gguf.part-02", sizeBytes: second.length, sha256: sha256(second) }
      ],
      outputFile: "model.gguf",
      totalBytes: first.length + second.length,
      installable: true,
      unavailableReason: null,
      assembly: { type: "concatenate", outputFile: "model.gguf" }
    };
    const downloads = await manager();
    const started = await downloads.start(catalogModel(variant), variant.id);
    const ready = await waitForDownload(downloads, started.id, (snapshot) => snapshot.stage === "ready");

    expect(await readFile(path.join(ready.destinationDirectory, "model.gguf"))).toEqual(Buffer.concat([first, second]));
    await expect(readFile(path.join(ready.destinationDirectory, "model.gguf.part-01"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(ready.totalBytes).toBe(first.length + second.length);
  });

  it("reports disk preflight failure without issuing a model GET", async () => {
    const data = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(128)]);
    files.set("model.gguf", data);
    const variant: CatalogModelVariant = {
      id: "variant-no-space",
      label: "Q2 K",
      files: [{ name: "model.gguf", sizeBytes: data.length, sha256: sha256(data) }],
      outputFile: "model.gguf",
      totalBytes: data.length,
      installable: true,
      unavailableReason: null,
      assembly: null
    };
    const downloads = await manager({ diskFreeBytes: 1 });
    const started = await downloads.start(catalogModel(variant), variant.id);
    const failed = await waitForDownload(downloads, started.id, (snapshot) => snapshot.stage === "error");

    expect(failed.error).toMatch(/Not enough free space/);
    expect(failed.disk.shortfallBytes).toBeGreaterThan(0);
    expect(requestedRanges).toEqual([]);
  });

  it("isolates checksum failures and can remove all partial state on cancellation", async () => {
    const data = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64, 3)]);
    files.set("bad.gguf", data);
    const variant: CatalogModelVariant = {
      id: "variant-bad",
      label: "Q2 K",
      files: [{ name: "bad.gguf", sizeBytes: data.length, sha256: "0".repeat(64) }],
      outputFile: "bad.gguf",
      totalBytes: data.length,
      installable: true,
      unavailableReason: null,
      assembly: null
    };
    const downloads = await manager();
    const internals = downloads as unknown as { persist(): Promise<void> };
    const persist = internals.persist.bind(downloads);
    let releaseErrorPersist!: () => void;
    const errorPersistReleased = new Promise<void>((resolve) => {
      releaseErrorPersist = resolve;
    });
    let reportErrorPersist!: () => void;
    const errorPersistStarted = new Promise<void>((resolve) => {
      reportErrorPersist = resolve;
    });
    let heldErrorPersist = false;
    internals.persist = async () => {
      if (!heldErrorPersist && downloads.list().some((snapshot) => snapshot.stage === "error")) {
        heldErrorPersist = true;
        reportErrorPersist();
        await errorPersistReleased;
      }
      await persist();
    };
    const started = await downloads.start(catalogModel(variant), variant.id);
    await errorPersistStarted;
    const failed = downloads.get(started.id);
    const cancellation = downloads.cancel(started.id, true);
    releaseErrorPersist();
    const cancelled = await cancellation;
    expect(failed.error).toMatch(/verification failed/);
    expect(cancelled).toMatchObject({ stage: "cancelled", downloadedBytes: 0, error: null });
    await expect(readFile(`${cancelled.destinationDirectory}.partial/bad.gguf.part`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
