import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices, type AppServices } from "../server/app.js";
import { TaskCancelledError } from "../server/runtime.js";
import type { CatalogModel, CatalogModelVariant, CatalogResponse, ModelDownloadSnapshot, RuntimeState } from "../src/types.js";

describe("DSBox API", () => {
  let home: string;
  let services: AppServices;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "dsbox-test-"));
    process.env.DSBOX_HOME = home;
    services = await createServices(4242);
  });

  afterEach(async () => {
    services.metrics.stop();
    delete process.env.DSBOX_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("reports a local, uninstalled first-run snapshot", async () => {
    const response = await request(createApp(services)).get("/api/state").expect(200);
    expect(response.body.runtime.phase).toBe("uninstalled");
    expect(response.body.config.repository.url).toBe("https://github.com/andreaborio/ds4.git");
    expect(response.body.system.openAiBaseUrl).toBe("http://127.0.0.1:4242/v1");
    expect(response.body.system.appleSilicon).toBe(process.platform === "darwin" && process.arch === "arm64");
  });

  it("validates config writes", async () => {
    const app = createApp(services);
    const current = (await request(app).get("/api/state")).body.config;
    await request(app).put("/api/config").set("x-dsbox-control", "1").send({ ...current, server: { ...current.server, internalHost: "0.0.0.0" } }).expect(400);
    const updated = { ...current, server: { ...current.server, contextTokens: 65_536 } };
    const response = await request(app).put("/api/config").set("x-dsbox-control", "1").send(updated).expect(200);
    expect(response.body.server.contextTokens).toBe(65_536);
  });

  it("rejects mutating control requests without the anti-CSRF header", async () => {
    await request(createApp(services)).post("/api/runtime/start").expect(403);
  });

  it("rejects non-loopback Host and Origin headers", async () => {
    const app = createApp(services);
    await request(app).get("/api/health").set("Host", "attacker.example").expect(403);
    await request(app)
      .post("/api/runtime/power")
      .set("x-dsbox-control", "1")
      .set("Origin", "https://attacker.example")
      .expect(403);
  });

  it("starts the selected local model through the power endpoint without implicit downloads", async () => {
    const modelPath = path.join(home, "my-local-model.gguf");
    await writeFile(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    await services.runtime.selectLocalModel(modelPath);
    const oneClickStart = vi.spyOn(services.runtime, "oneClickStart").mockResolvedValue();

    const response = await request(createApp(services))
      .post("/api/runtime/power")
      .set("x-dsbox-control", "1")
      .expect(202);

    expect(response.body).toEqual({ accepted: true, action: "start" });
    expect(services.runtime.getState().phase).toBe("preparing");
    const repeated = await request(createApp(services))
      .post("/api/runtime/power")
      .set("x-dsbox-control", "1")
      .expect(202);
    expect(repeated.body).toEqual({ accepted: true, action: "working" });
    await vi.waitFor(() => expect(oneClickStart).toHaveBeenCalledOnce());
    expect(oneClickStart).toHaveBeenCalledWith();
  });

  it("requires an explicit model choice before power-on", async () => {
    const oneClickStart = vi.spyOn(services.runtime, "oneClickStart").mockResolvedValue();
    const response = await request(createApp(services))
      .post("/api/runtime/power")
      .set("x-dsbox-control", "1")
      .expect(409);
    expect(response.body.error).toMatch(/Choose a GGUF file/);
    expect(oneClickStart).not.toHaveBeenCalled();
  });

  it("discovers and selects a valid GGUF without starting a download", async () => {
    const modelPath = path.join(home, "glm52-local.gguf");
    await writeFile(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    const app = createApp(services);
    const selected = await request(app)
      .post("/api/models/local/select")
      .set("x-dsbox-control", "1")
      .send({ path: modelPath })
      .expect(200);
    expect(selected.body).toMatchObject({ path: modelPath, modelId: "glm-5.2", selected: true });
    const local = await request(app).get("/api/models/local").expect(200);
    expect(local.body.models).toContainEqual(expect.objectContaining({ path: modelPath, selected: true }));
    expect(services.runtime.getState()).toMatchObject({ modelPresent: true, pid: null });
    expect(services.runtime.hasTask()).toBe(false);
  });

  it("refreshes the saved model ID when a known GGUF gets authoritative metadata", async () => {
    const selectedPath = path.join(home, "selected-local.gguf");
    const rememberedPath = path.join(home, "remembered-local.gguf");
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]);
    await writeFile(selectedPath, gguf);
    await writeFile(rememberedPath, gguf);
    await services.runtime.selectLocalModel(selectedPath, "selected-model");

    await services.runtime.rememberLocalModel(rememberedPath, "generic-local-id");
    await services.runtime.rememberLocalModel(rememberedPath, "catalog-model-id");

    const local = await request(createApp(services)).get("/api/models/local").expect(200);
    expect(local.body.models).toContainEqual(expect.objectContaining({
      path: rememberedPath,
      modelId: "catalog-model-id",
      selected: false
    }));
    expect(services.runtime.getState().pid).toBeNull();
  });

  it("switches to an installed GGUF without starting DS4 when it is off", async () => {
    const firstPath = path.join(home, "first-local.gguf");
    const secondPath = path.join(home, "second-local.gguf");
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]);
    await writeFile(firstPath, gguf);
    await writeFile(secondPath, gguf);
    await services.runtime.selectLocalModel(firstPath, "first-model");
    const internal = services.runtime as unknown as {
      stopEngine(): Promise<void>;
      startManaged(modelSwitch?: boolean): Promise<void>;
    };
    const startManaged = vi.spyOn(internal, "startManaged");
    const stopEngine = vi.spyOn(internal, "stopEngine");

    const response = await request(createApp(services))
      .post("/api/models/local/switch")
      .set("x-dsbox-control", "1")
      .send({ path: secondPath, modelId: "second-model" })
      .expect(200);

    expect(response.body).toMatchObject({
      changed: true,
      restarted: false,
      model: { path: secondPath, modelId: "second-model", selected: true }
    });
    expect(services.store.get().model).toEqual({ path: secondPath, id: "second-model" });
    expect(startManaged).not.toHaveBeenCalled();
    expect(stopEngine).not.toHaveBeenCalled();
    expect(services.runtime.getState().pid).toBeNull();
  });

  it("validates a replacement GGUF before stopping a running DS4 process", async () => {
    const currentPath = path.join(home, "current-local.gguf");
    const invalidPath = path.join(home, "invalid-local.gguf");
    await writeFile(currentPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    await writeFile(invalidPath, "not a GGUF");
    await services.runtime.selectLocalModel(currentPath, "current-model");
    const internal = services.runtime as unknown as {
      engine: { pid: number } | null;
      state: RuntimeState;
      stopEngine(): Promise<void>;
    };
    internal.engine = { pid: 1234 };
    internal.state = { ...services.runtime.getState(), phase: "running", readiness: "ready", pid: 1234 };
    const stopEngine = vi.spyOn(internal, "stopEngine");

    await request(createApp(services))
      .post("/api/models/local/switch")
      .set("x-dsbox-control", "1")
      .send({ path: invalidPath })
      .expect(400);

    expect(stopEngine).not.toHaveBeenCalled();
    expect(internal.engine).not.toBeNull();
    expect(services.store.get().model).toEqual({ path: currentPath, id: "current-model" });
    internal.engine = null;
  });

  it("restarts a running DS4 process exactly once after an installed model is selected", async () => {
    const currentPath = path.join(home, "running-current.gguf");
    const nextPath = path.join(home, "running-next.gguf");
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]);
    await writeFile(currentPath, gguf);
    await writeFile(nextPath, gguf);
    await services.runtime.selectLocalModel(currentPath, "running-current");
    const internal = services.runtime as unknown as {
      engine: { pid: number } | null;
      state: RuntimeState;
      stopEngine(): Promise<void>;
      startManaged(modelSwitch?: boolean): Promise<void>;
    };
    internal.engine = { pid: 1234 };
    internal.state = { ...services.runtime.getState(), phase: "running", readiness: "ready", pid: 1234 };
    const stopEngine = vi.spyOn(internal, "stopEngine").mockImplementation(async () => {
      internal.engine = null;
      internal.state = { ...internal.state, phase: "idle", readiness: "offline", pid: null };
    });
    const startManaged = vi.spyOn(internal, "startManaged").mockImplementation(async () => {
      internal.engine = { pid: 5678 };
      internal.state = { ...internal.state, phase: "running", readiness: "ready", pid: 5678 };
    });

    const response = await request(createApp(services))
      .post("/api/models/local/switch")
      .set("x-dsbox-control", "1")
      .send({ path: nextPath, modelId: "running-next" })
      .expect(200);

    expect(response.body).toMatchObject({
      changed: true,
      restarted: true,
      model: { path: nextPath, modelId: "running-next", selected: true }
    });
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(startManaged).toHaveBeenCalledOnce();
    expect(startManaged).toHaveBeenCalledWith(true);
    expect(services.store.get().model).toEqual({ path: nextPath, id: "running-next" });
    internal.engine = null;
  });

  it("rolls back the model and restores the previous runtime when a hot switch fails", async () => {
    const previousPath = path.join(home, "previous-local.gguf");
    const nextPath = path.join(home, "next-local.gguf");
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]);
    await writeFile(previousPath, gguf);
    await writeFile(nextPath, gguf);
    await services.runtime.selectLocalModel(previousPath, "previous-model");
    const internal = services.runtime as unknown as {
      engine: { pid: number } | null;
      state: RuntimeState;
      stopEngine(): Promise<void>;
      startManaged(modelSwitch?: boolean): Promise<void>;
    };
    internal.engine = { pid: 1234 };
    internal.state = { ...services.runtime.getState(), phase: "running", readiness: "ready", pid: 1234 };
    vi.spyOn(internal, "stopEngine").mockImplementation(async () => {
      internal.engine = null;
      internal.state = { ...internal.state, phase: "idle", readiness: "offline", pid: null };
    });
    const startManaged = vi.spyOn(internal, "startManaged")
      .mockRejectedValueOnce(new Error("new model could not load"))
      .mockImplementationOnce(async () => {
        internal.engine = { pid: 5678 };
        internal.state = { ...internal.state, phase: "running", readiness: "ready", pid: 5678 };
      });

    const response = await request(createApp(services))
      .post("/api/models/local/switch")
      .set("x-dsbox-control", "1")
      .send({ path: nextPath, modelId: "next-model" })
      .expect(500);

    expect(response.body).toMatchObject({
      code: "model_switch_failed",
      rolledBack: true,
      runtimeRestored: true
    });
    expect(response.body.error).toMatch(/previous model selection was restored and DS4 was relaunched/i);
    expect(services.store.get().model).toEqual({ path: previousPath, id: "previous-model" });
    expect(startManaged).toHaveBeenCalledTimes(2);
    expect(internal.engine?.pid).toBe(5678);
    internal.engine = null;
  });

  it("runs a pollable full-disk scan and returns validated GGUF results", async () => {
    const nestedDirectory = path.join(home, "nested", "models");
    const modelPath = path.join(nestedDirectory, "local-scan.gguf");
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    const app = createApp(services);

    const started = await request(app)
      .post("/api/models/local/scan")
      .set("x-dsbox-control", "1")
      .expect(202);
    expect(started.body).toMatchObject({
      status: "scanning",
      stage: "spotlight",
      strategy: "none",
      progress: { directoriesScanned: 0, entriesScanned: 0, candidateFiles: 0, modelsFound: 0 }
    });

    await vi.waitFor(async () => {
      const scan = await request(app).get("/api/models/local/scan").expect(200);
      expect(scan.body.status).toBe("complete");
    });
    const completed = await request(app).get("/api/models/local/scan").expect(200);
    expect(completed.body).toMatchObject({
      status: "complete",
      stage: "complete",
      strategy: "filesystem-fallback",
      error: null,
      truncated: false
    });
    expect(completed.body.progress.modelsFound).toBe(1);
    expect(completed.body.models).toContainEqual(expect.objectContaining({ path: modelPath, name: "local-scan" }));
    expect(services.runtime.getState().pid).toBeNull();
    expect(services.runtime.hasTask()).toBe(false);

    const inventoryPath = path.join(home, "local-models.json");
    expect(JSON.parse(await readFile(inventoryPath, "utf8"))).toMatchObject({
      version: 1,
      models: [expect.objectContaining({ path: modelPath, modelId: "local-scan" })]
    });

    services.metrics.stop();
    services = await createServices(4242);
    const restartedApp = createApp(services);
    const restartedRuntime = services.runtime as unknown as {
      filesystemGgufPaths(signal: AbortSignal): Promise<{ paths: string[]; truncated: boolean }>;
    };
    const filesystemScan = vi.spyOn(restartedRuntime, "filesystemGgufPaths");
    const restored = await request(restartedApp).get("/api/models/local").expect(200);
    expect(restored.body.models).toContainEqual(expect.objectContaining({ path: modelPath, selected: false }));
    expect(filesystemScan).not.toHaveBeenCalled();

    await unlink(modelPath);
    const pruned = await request(restartedApp).get("/api/models/local").expect(200);
    expect(pruned.body.models).not.toContainEqual(expect.objectContaining({ path: modelPath }));
    expect(JSON.parse(await readFile(inventoryPath, "utf8"))).toMatchObject({ version: 1, models: [] });
  });

  it("keeps validated findings when a local-model scan is cancelled", async () => {
    const modelDirectory = path.join(home, "cancelled-scan");
    const foundPath = path.join(modelDirectory, "found-before-cancel.gguf");
    const blockedPath = path.join(modelDirectory, "blocked-during-cancel.gguf");
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(foundPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    await writeFile(blockedPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));

    const internal = services.runtime as unknown as {
      spotlightGgufPaths(
        signal: AbortSignal,
        onCandidateCount: (count: number) => void
      ): Promise<{ paths: string[]; truncated: boolean } | null>;
      inspectLocalModel(filePath: string, selectedPath: string): Promise<import("../src/types.js").LocalModelCandidate | null>;
    };
    const inspectLocalModel = internal.inspectLocalModel.bind(internal);
    vi.spyOn(internal, "spotlightGgufPaths").mockImplementation(async (_signal, onCandidateCount) => {
      onCandidateCount(2);
      return { paths: [foundPath, blockedPath], truncated: false };
    });
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    let markBlockedStarted!: () => void;
    const blockedStarted = new Promise<void>((resolve) => { markBlockedStarted = resolve; });
    vi.spyOn(internal, "inspectLocalModel").mockImplementation(async (filePath, selectedPath) => {
      if (path.resolve(filePath) === blockedPath) {
        markBlockedStarted();
        await blocked;
      }
      return inspectLocalModel(filePath, selectedPath);
    });

    const app = createApp(services);
    await request(app).post("/api/models/local/scan").set("x-dsbox-control", "1").expect(202);
    await blockedStarted;
    await request(app).post("/api/models/local/scan/cancel").set("x-dsbox-control", "1").expect(200);
    releaseBlocked();

    const inventoryPath = path.join(home, "local-models.json");
    await vi.waitFor(async () => {
      const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as { models: Array<{ path: string }> };
      expect(inventory.models).toContainEqual(expect.objectContaining({ path: foundPath }));
      expect(inventory.models).not.toContainEqual(expect.objectContaining({ path: blockedPath }));
    });

    services.metrics.stop();
    services = await createServices(4242);
    const restored = await request(createApp(services)).get("/api/models/local").expect(200);
    expect(restored.body.models).toContainEqual(expect.objectContaining({ path: foundPath }));
    expect(restored.body.models).not.toContainEqual(expect.objectContaining({ path: blockedPath }));
    expect(services.runtime.getState().pid).toBeNull();
  });

  it("cancels a running local-model scan without touching the runtime", async () => {
    const internal = services.runtime as unknown as {
      filesystemGgufPaths(signal: AbortSignal): Promise<{ paths: string[]; truncated: boolean }>;
    };
    vi.spyOn(internal, "filesystemGgufPaths").mockImplementation(async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
      });
      return { paths: [], truncated: false };
    });
    const app = createApp(services);
    await request(app).post("/api/models/local/scan").set("x-dsbox-control", "1").expect(202);
    await vi.waitFor(() => expect(services.runtime.getLocalModelScan().stage).toBe("filesystem"));

    const cancelled = await request(app)
      .post("/api/models/local/scan/cancel")
      .set("x-dsbox-control", "1")
      .expect(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", stage: "idle", error: null });
    await vi.waitFor(() => {
      expect((services.runtime as unknown as { localModelScanController: AbortController | null }).localModelScanController).toBeNull();
    });
    expect(services.runtime.getState().pid).toBeNull();
    expect(services.runtime.hasTask()).toBe(false);
  });

  it("selects a Finder-picked GGUF through the existing validation path", async () => {
    const modelPath = path.join(home, "finder-model.gguf");
    const invalidPath = path.join(home, "finder-invalid.gguf");
    await writeFile(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    await writeFile(invalidPath, "not a GGUF");

    await expect(services.runtime.chooseLocalModelFromFinder(async () => modelPath)).resolves.toMatchObject({
      cancelled: false,
      model: { path: modelPath, selected: true }
    });
    expect(services.store.get().model.path).toBe(modelPath);
    await expect(services.runtime.chooseLocalModelFromFinder(async () => null)).resolves.toEqual({
      cancelled: true,
      model: null
    });
    await expect(services.runtime.chooseLocalModelFromFinder(async () => invalidPath)).rejects.toThrow(/readable GGUF/);
    expect(services.store.get().model.path).toBe(modelPath);
    expect(services.runtime.getState().pid).toBeNull();
  });

  it("exposes clean native-picker cancellation through the API", async () => {
    vi.spyOn(services.runtime, "chooseLocalModelFromFinder").mockResolvedValue({ cancelled: true, model: null });
    const response = await request(createApp(services))
      .post("/api/models/local/choose")
      .set("x-dsbox-control", "1")
      .expect(200);
    expect(response.body).toEqual({ cancelled: true, model: null });
  });

  it("does not present incomplete GGUF shards as usable models", async () => {
    const shardPath = path.join(home, "split-00001-of-00003.gguf");
    await writeFile(shardPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    const app = createApp(services);
    await request(app)
      .post("/api/models/local/select")
      .set("x-dsbox-control", "1")
      .send({ path: shardPath })
      .expect(400);
    const local = await request(app).get("/api/models/local").expect(200);
    expect(local.body.models).not.toContainEqual(expect.objectContaining({ path: shardPath }));
  });

  it("accepts a complete multipart GGUF once and reports its aggregate size", async () => {
    const bytes = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]);
    const firstShard = path.join(home, "complete-00001-of-00002.gguf");
    await writeFile(firstShard, bytes);
    await writeFile(path.join(home, "complete-00002-of-00002.gguf"), bytes);
    const app = createApp(services);
    const selected = await request(app)
      .post("/api/models/local/select")
      .set("x-dsbox-control", "1")
      .send({ path: firstShard })
      .expect(200);
    expect(selected.body).toMatchObject({ path: firstShard, name: "complete", sizeBytes: bytes.length * 2, selected: true });
    const local = await request(app).get("/api/models/local").expect(200);
    expect(local.body.models.filter((model: { path: string }) => model.path.includes("complete-0000"))).toHaveLength(1);
  });

  it("rejects invalid local files and treats repeated cancellation as safe", async () => {
    const invalidPath = path.join(home, "not-a-model.gguf");
    await writeFile(invalidPath, "not gguf");
    const app = createApp(services);
    await request(app)
      .post("/api/models/local/select")
      .set("x-dsbox-control", "1")
      .send({ path: invalidPath })
      .expect(400);
    const cancelled = await request(app)
      .post("/api/runtime/cancel-task")
      .set("x-dsbox-control", "1")
      .expect(200);
    expect(cancelled.body).toEqual({ ok: true, alreadyStopped: true });
  });

  it("cancels the active child only and leaves the next task unaffected", async () => {
    const internal = services.runtime as unknown as {
      runTask(command: string, args: string[], cwd: string, source: "download"): Promise<void>;
    };
    const result = internal.runTask("/bin/sh", ["-c", "sleep 30"], home, "download")
      .then(() => null)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(services.runtime.hasTask()).toBe(true));
    await expect(services.runtime.cancelTask()).resolves.toBe(true);
    expect(await result).toBeInstanceOf(TaskCancelledError);
    expect(services.runtime.hasTask()).toBe(false);
    await expect(internal.runTask("/bin/sh", ["-c", "exit 0"], home, "download")).resolves.toBeUndefined();
  });

  it("keeps cancellation and model selection races out of the error state", async () => {
    const modelPath = path.join(home, "safe-local.gguf");
    await writeFile(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    await services.runtime.selectLocalModel(modelPath);
    services.runtime.prepareOneClickStart();
    vi.spyOn(services.runtime, "installOrUpdate").mockRejectedValue(new TaskCancelledError());
    await expect(services.runtime.oneClickStart()).rejects.toBeInstanceOf(TaskCancelledError);
    expect(services.runtime.getState()).toMatchObject({ phase: "uninstalled", lastError: null });
  });

  it("does not switch models while one-click startup is preparing", async () => {
    const firstPath = path.join(home, "first.gguf");
    const secondPath = path.join(home, "second.gguf");
    await writeFile(firstPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    await writeFile(secondPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
    await services.runtime.selectLocalModel(firstPath);
    services.runtime.prepareOneClickStart();
    await expect(services.runtime.selectLocalModel(secondPath)).rejects.toThrow(/Cancel the download|turn off DSBox/);
    expect(services.store.get().model.path).toBe(firstPath);
  });

  it("starts a pinned in-app catalog variant and exposes the download contract", async () => {
    const variant: CatalogModelVariant = {
      id: "variant-1",
      label: "Q2 K",
      files: [{ name: "model.gguf", sizeBytes: 1024, sha256: "a".repeat(64) }],
      outputFile: "model.gguf",
      totalBytes: 1024,
      installable: true,
      unavailableReason: null,
      assembly: null
    };
    const model: CatalogModel = {
      publisher: "unsloth",
      repository: "unsloth/Test-GGUF",
      revision: "b".repeat(40),
      label: "Test model",
      description: "Test",
      modelId: "test",
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
      sourceUrl: "https://huggingface.co/unsloth/Test-GGUF",
      unavailableReason: "Choose a quantization in DSBox",
      variantCount: 1,
      variants: [variant]
    };
    const catalog: CatalogResponse = {
      author: "andreaborio",
      label: "DSBox Models",
      sources: [],
      models: [model],
      recommended: null,
      refreshedAt: new Date().toISOString(),
      stale: false
    };
    const download = {
      id: "download-1",
      repository: model.repository,
      revision: model.revision,
      variantId: variant.id,
      stage: "queued"
    } as ModelDownloadSnapshot;
    vi.spyOn(services.catalog, "list").mockResolvedValue(catalog);
    const start = vi.spyOn(services.downloads, "start").mockResolvedValue(download);
    vi.spyOn(services.downloads, "list").mockReturnValue([download]);
    const app = createApp(services);

    const started = await request(app)
      .post("/api/models/download")
      .set("x-dsbox-control", "1")
      .send({ repository: model.repository, revision: model.revision, variantId: variant.id })
      .expect(202);
    expect(start).toHaveBeenCalledWith(model, variant.id);
    expect(started.body).toEqual({ accepted: true, download });
    const listed = await request(app).get("/api/models/downloads").expect(200);
    expect(listed.body).toEqual({ downloads: [download] });
  });
});

describe("gateway passthrough", () => {
  let home: string;
  let fake: Server;
  let services: AppServices;
  let markDelayedStarted: (() => void) | null;
  let markDelayedClosed: (() => void) | null;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "dsbox-gateway-"));
    process.env.DSBOX_HOME = home;
    markDelayedStarted = null;
    markDelayedClosed = null;
    fake = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-flash" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.setHeader("content-type", "text/event-stream");
        res.write(": prefill\n\n");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      if (req.url === "/v1/responses") {
        markDelayedStarted?.();
        const closed = () => markDelayedClosed?.();
        req.once("aborted", closed);
        req.once("close", closed);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (!address || typeof address === "string") throw new Error("fake server did not bind");
    services = await createServices(4242);
    const config = services.store.get();
    config.server.internalPort = address.port;
    await services.store.set(config);
    const original = services.runtime.getState();
    services.runtime.getState = () => ({ ...original, phase: "running", readiness: "ready" });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    delete process.env.DSBOX_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("relays model discovery", async () => {
    const response = await request(createApp(services)).get("/v1/models").expect(200);
    expect(response.body.data[0].id).toBe("deepseek-v4-flash");
    expect(response.headers["x-dsbox-gateway"]).toBe("1");
    expect(services.activity.stage).toBe("idle");
  });

  it("enforces the optional gateway API key", async () => {
    const config = services.store.get();
    config.gateway.requireApiKey = true;
    config.gateway.apiKey = "dsbox-test-secret";
    await services.store.set(config);
    const app = createApp(services);
    await request(app).get("/v1/models").expect(401);
    await request(app).get("/v1/models").set("authorization", "Bearer dsbox-test-secret").expect(200);
  });

  it("preserves SSE prefill comments and data frames", async () => {
    const activityStages: string[] = [];
    services.bus.on("event", (event) => {
      if (event.type === "activity") activityStages.push(event.payload.stage);
    });
    const response = await request(createApp(services))
      .post("/api/chat")
      .set("x-dsbox-control", "1")
      .send({ model: "deepseek-v4-flash", messages: [], stream: true })
      .expect(200)
      .expect("content-type", /text\/event-stream/);
    expect(response.text).toContain(": prefill");
    expect(response.text).toContain('"content":"hello"');
    expect(response.text).toContain("data: [DONE]");
    expect(activityStages).toContain("prefill");
    expect(activityStages).toContain("decode");
    expect(activityStages.at(-1)).toBe("idle");
  });

  it("rejects media input before it can reach the text-only DS4 runtime", async () => {
    const response = await request(createApp(services))
      .post("/api/chat")
      .set("x-dsbox-control", "1")
      .send({
        model: "deepseek-v4-flash",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
          ]
        }]
      })
      .expect(422);

    expect(response.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "unsupported_input_modality",
      modality: "image",
      location: "messages[0].content[1]"
    });
    expect(services.activity.stage).toBe("idle");
  });

  it("aborts DS4 before upstream headers when the client disconnects", async () => {
    const upstreamStarted = new Promise<void>((resolve) => { markDelayedStarted = resolve; });
    const upstreamClosed = new Promise<void>((resolve) => { markDelayedClosed = resolve; });
    const gateway = createApp(services).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => gateway.once("listening", resolve));
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");

    try {
      const client = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/v1/responses",
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      client.on("error", () => undefined);
      client.end(JSON.stringify({ model: "deepseek-v4-flash", input: "test" }));
      await upstreamStarted;
      client.destroy();
      await upstreamClosed;
      await vi.waitFor(() => expect(services.activity.stage).toBe("idle"));
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });
});
