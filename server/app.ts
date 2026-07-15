import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { arch, cpus, hostname, platform, totalmem } from "node:os";
import { ZodError } from "zod";
import type { AppSnapshot, InferenceActivity, InferenceStage, ServerEvent, SystemInfo } from "../src/types.js";
import { ConfigStore } from "./config.js";
import { EventBus } from "./event-bus.js";
import { MetricsMonitor } from "./metrics.js";
import { ModelSelectionError, ModelSwitchError, RuntimeManager, isTaskCancelledError } from "./runtime.js";
import { ModelCatalog } from "./catalog.js";
import { ModelDownloadError, ModelDownloadManager } from "./model-downloads.js";
import { CONTENT_SECURITY_POLICY } from "./security.js";
import { assertTextOnlyInput, UnsupportedInputModalityError } from "./text-only.js";
import { searchWeb } from "./web-search.js";

export interface AppServices {
  store: ConfigStore;
  bus: EventBus;
  runtime: RuntimeManager;
  metrics: MetricsMonitor;
  catalog: ModelCatalog;
  downloads: ModelDownloadManager;
  activity: InferenceActivity;
  system: SystemInfo;
}

let nextInferenceRequestId = 1;

function applicationVersion(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "../package.json"),
    path.resolve(moduleDirectory, "../../package.json"),
    path.resolve(process.cwd(), "package.json")
  ];
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof manifest.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
        return manifest.version;
      }
    } catch {
      // Try the next source/build layout.
    }
  }
  return "unknown";
}

const APP_VERSION = applicationVersion();

function setInferenceActivity(
  services: AppServices,
  stage: InferenceStage,
  source: InferenceActivity["source"],
  requestId: string | null,
  startedAt: string | null
): void {
  services.activity = { stage, source, requestId, startedAt };
  services.bus.publish({ type: "activity", payload: structuredClone(services.activity) });
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next);
  };
}

function gatewayAuthorized(request: Request, store: ConfigStore): boolean {
  const { requireApiKey, apiKey } = store.get().gateway;
  if (!requireApiKey) return true;
  const bearer = request.header("authorization")?.replace(/^Bearer\s+/i, "");
  const anthropic = request.header("x-api-key");
  return bearer === apiKey || anthropic === apiKey;
}

function isLoopbackUrlHost(value: string): boolean {
  try {
    const hostname = new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

function copyResponseHeaders(source: globalThis.Response, target: Response): void {
  const excluded = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive"]);
  source.headers.forEach((value, key) => {
    if (!excluded.has(key.toLowerCase())) target.setHeader(key, value);
  });
  target.setHeader("x-dsbox-gateway", "1");
}

async function relayToDs4(
  request: Request,
  response: Response,
  services: AppServices,
  targetPath: string,
  requireGatewayAuth: boolean,
  activitySource: "chat" | "agent"
): Promise<void> {
  if (services.runtime.getState().readiness !== "ready") {
    response.status(503).json({
      error: {
        message: "ds4-server is not ready yet",
        type: "dsbox_runtime_unavailable"
      }
    });
    return;
  }
  if (requireGatewayAuth && !gatewayAuthorized(request, services.store)) {
    response.status(401).json({
      error: { message: "Invalid DSBox API key", type: "authentication_error" }
    });
    return;
  }

  assertTextOnlyInput(request.body);

  const config = services.store.get();
  const target = `http://${config.server.internalHost}:${config.server.internalPort}${targetPath}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (["host", "connection", "content-length"].includes(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("host", `${config.server.internalHost}:${config.server.internalPort}`);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const tracksInference = hasBody && !targetPath.endsWith("/models");
  const requestId = tracksInference ? `${Date.now()}-${nextInferenceRequestId++}` : null;
  const startedAt = tracksInference ? new Date().toISOString() : null;
  if (requestId) setInferenceActivity(services, "prefill", activitySource, requestId, startedAt);
  const upstreamController = new AbortController();
  let clientDisconnected = false;
  const abortForClient = () => {
    clientDisconnected = true;
    upstreamController.abort();
  };
  request.once("aborted", abortForClient);
  response.once("close", abortForClient);
  const upstreamTimeout = setTimeout(
    () => upstreamController.abort(new Error("Timeout gateway DSBox")),
    30 * 60 * 1000
  );
  upstreamTimeout.unref();
  const finishActivity = () => {
    clearTimeout(upstreamTimeout);
    request.off("aborted", abortForClient);
    response.off("close", abortForClient);
    if (requestId && services.activity.requestId === requestId) setInferenceActivity(services, "idle", null, null, null);
  };
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
      signal: upstreamController.signal
    });
  } catch (error) {
    finishActivity();
    if (clientDisconnected) return;
    throw error;
  }
  response.status(upstream.status);
  copyResponseHeaders(upstream, response);
  if (!upstream.body) {
    finishActivity();
    response.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
  let activityBuffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    activityBuffer = `${activityBuffer}${chunk.toString()}`.slice(-2048);
    if (/output_text\.delta|"content"\s*:\s*"|"type"\s*:\s*"text_delta"/i.test(activityBuffer)) {
      if (requestId && services.activity.requestId === requestId && services.activity.stage !== "decode") {
        setInferenceActivity(services, "decode", activitySource, requestId, startedAt);
      }
    } else if (/reasoning_content"\s*:\s*"|reasoning_summary_text\.delta|response\.reasoning|"type"\s*:\s*"thinking_delta"/i.test(activityBuffer)) {
      if (requestId && services.activity.requestId === requestId && services.activity.stage !== "thinking") {
        setInferenceActivity(services, "thinking", activitySource, requestId, startedAt);
      }
    }
  });
  response.once("close", () => {
    upstreamController.abort();
    stream.destroy();
    finishActivity();
  });
  stream.once("end", finishActivity);
  stream.on("error", (error) => {
    services.runtime.log("error", "dsbox", `Gateway stream: ${error.message}`);
    finishActivity();
    if (!response.headersSent) response.status(502);
    response.end();
  });
  stream.pipe(response);
}

export async function createServices(port: number): Promise<AppServices> {
  const store = await ConfigStore.open(totalmem());
  const bus = new EventBus();
  const runtime = new RuntimeManager(store, bus);
  await runtime.refresh();
  const metrics = new MetricsMonitor(store, runtime, bus);
  const catalog = new ModelCatalog();
  const downloads = await ModelDownloadManager.open(store, bus, {
    canStart: () => !runtime.hasTask() && !runtime.isSwitchingModel() && runtime.getState().pid === null,
    validateReadyModel: async (modelPath) => {
      await runtime.validateLocalModel(modelPath);
    },
    onReady: async (modelPath, modelId) => {
      try {
        await runtime.rememberLocalModel(modelPath, modelId);
      } catch (error) {
        runtime.log("warn", "dsbox", `The downloaded model is ready, but its local inventory entry could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      }
      await runtime.refresh();
    }
  });
  const activity: InferenceActivity = { stage: "idle", source: null, requestId: null, startedAt: null };
  const cpuList = cpus();
  const gatewayBaseUrl = `http://127.0.0.1:${port}`;
  const system: SystemInfo = {
    platform: platform(),
    arch: arch(),
    hostname: hostname(),
    cpuModel: cpuList[0]?.model ?? "Unknown CPU",
    cpuCores: cpuList.length,
    totalMemoryBytes: totalmem(),
    appleSilicon: platform() === "darwin" && arch() === "arm64",
    gatewayBaseUrl,
    openAiBaseUrl: `${gatewayBaseUrl}/v1`,
    anthropicBaseUrl: gatewayBaseUrl
  };
  return { store, bus, runtime, metrics, catalog, downloads, activity, system };
}

export function makeSnapshot(services: AppServices): AppSnapshot {
  return {
    config: services.store.get(),
    runtime: services.runtime.getState(),
    downloads: services.downloads.list(),
    metrics: services.metrics.getHistory(),
    logs: services.runtime.getLogs(),
    activity: structuredClone(services.activity),
    system: services.system
  };
}

export function createApp(services: AppServices) {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    if (!isLoopbackUrlHost(request.header("host") ?? "")) {
      response.status(403).json({ error: "Host not allowed" });
      return;
    }
    const origin = request.header("origin");
    if (origin && !isLoopbackUrlHost(origin)) {
      response.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64mb" }));
  app.use("/api", (request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.header("x-dsbox-control") === "1") {
      next();
      return;
    }
    response.status(403).json({ error: "Missing DSBox control header" });
  });

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, version: APP_VERSION, runtime: services.runtime.getState().phase });
  });

  app.get("/api/state", (_request, response) => {
    response.json(makeSnapshot(services));
  });

  app.get("/api/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const snapshot: ServerEvent = { type: "snapshot", payload: makeSnapshot(services) };
    response.write(`event: dsbox\ndata: ${JSON.stringify(snapshot)}\n\n`);

    const listener = (event: ServerEvent) => {
      response.write(`event: dsbox\ndata: ${JSON.stringify(event)}\n\n`);
    };
    services.bus.on("event", listener);
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    request.once("close", () => {
      clearInterval(heartbeat);
      services.bus.off("event", listener);
    });
  });

  app.put("/api/config", asyncRoute(async (request, response) => {
    if (services.runtime.isSwitchingModel()) {
      response.status(409).json({ error: "Wait for the model switch to finish before changing settings" });
      return;
    }
    const config = await services.store.set(request.body);
    services.bus.publish({ type: "config", payload: config });
    if (["running", "starting"].includes(services.runtime.getState().phase)) {
      services.runtime.log("warn", "dsbox", "Configuration saved. Restart the runtime to apply the flags.");
    }
    await services.runtime.refresh();
    response.json(config);
  }));

  app.get("/api/runtime/command", asyncRoute(async (_request, response) => {
    response.json({ command: await services.runtime.commandPreview() });
  }));

  app.get("/api/runtime/discover", asyncRoute(async (_request, response) => {
    response.json({ checkouts: await services.runtime.discoveredCheckouts() });
  }));

  app.get("/api/models/catalog", asyncRoute(async (request, response) => {
    const force = request.query.refresh === "1";
    response.json(await services.catalog.list(services.system.totalMemoryBytes, force));
  }));

  app.get("/api/models/downloads", (_request, response) => {
    response.json({ downloads: services.downloads.list() });
  });

  app.get("/api/models/downloads/:id", (request, response) => {
    response.json(services.downloads.get(String(request.params.id)));
  });

  app.get("/api/models/local", asyncRoute(async (_request, response) => {
    response.json({ models: await services.runtime.discoverLocalModels() });
  }));

  app.get("/api/models/local/scan", (_request, response) => {
    response.json(services.runtime.getLocalModelScan());
  });

  app.post("/api/models/local/scan", (_request, response) => {
    response.status(202).json(services.runtime.startLocalModelScan());
  });

  app.post("/api/models/local/scan/cancel", (_request, response) => {
    response.json(services.runtime.cancelLocalModelScan());
  });

  app.post("/api/models/local/choose", asyncRoute(async (_request, response) => {
    try {
      response.json(await services.runtime.chooseLocalModelFromFinder());
    } catch (error) {
      if (error instanceof ModelSelectionError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/models/local/select", asyncRoute(async (request, response) => {
    const modelPath = String(request.body?.path ?? "");
    const modelId = request.body?.modelId ? String(request.body.modelId) : undefined;
    try {
      response.json(await services.runtime.selectLocalModel(modelPath, modelId));
    } catch (error) {
      if (error instanceof ModelSelectionError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/models/local/switch", asyncRoute(async (request, response) => {
    if (services.downloads.hasActive()) {
      response.status(409).json({ error: "Pause the active model download before switching models" });
      return;
    }
    const modelPath = String(request.body?.path ?? "");
    const modelId = request.body?.modelId ? String(request.body.modelId) : undefined;
    try {
      response.json(await services.runtime.switchLocalModel(modelPath, modelId));
    } catch (error) {
      if (error instanceof ModelSwitchError) {
        response.status(error.status).json({
          error: error.message,
          code: "model_switch_failed",
          rolledBack: error.rolledBack,
          runtimeRestored: error.runtimeRestored
        });
        return;
      }
      if (error instanceof ModelSelectionError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/models/download", asyncRoute(async (request, response) => {
    const repository = String(request.body?.repository ?? "");
    const revision = request.body?.revision ? String(request.body.revision) : null;
    const variantId = request.body?.variantId ? String(request.body.variantId) : undefined;
    const catalog = await services.catalog.list(services.system.totalMemoryBytes);
    const model = catalog.models.find((candidate) => candidate.repository === repository
      && (!revision || candidate.revision === revision));
    if (!model) throw new ModelDownloadError("Model not found in the pinned DSBox catalog", 404);
    if (!model.installable) {
      throw new ModelDownloadError(model.unavailableReason ?? "This catalog source is not directly installable in DSBox", 409);
    }
    await services.runtime.prepareCatalogRuntime(model);
    const download = await services.downloads.start(model, variantId);
    response.status(202).json({ accepted: true, download });
  }));

  app.post("/api/models/downloads/:id/resume", asyncRoute(async (request, response) => {
    const download = await services.downloads.resume(String(request.params.id));
    response.status(202).json({ accepted: true, download });
  }));

  app.post("/api/models/downloads/:id/cancel", asyncRoute(async (request, response) => {
    const download = await services.downloads.cancel(
      String(request.params.id),
      request.body?.removePartials === true
    );
    response.json({ ok: true, download });
  }));

  app.post("/api/runtime/install", (_request, response) => {
    void services.runtime.installOrUpdate().catch(() => undefined);
    response.status(202).json({ accepted: true });
  });

  app.post("/api/runtime/build", (_request, response) => {
    void services.runtime.build().catch(() => undefined);
    response.status(202).json({ accepted: true });
  });

  app.post("/api/runtime/download", (request, response) => {
    const variant = String(request.body?.variant ?? "");
    services.runtime.downloadModel(variant).catch(() => undefined);
    response.status(202).json({ accepted: true });
  });

  app.post("/api/runtime/cancel-task", asyncRoute(async (_request, response) => {
    const activeDownload = services.downloads.list().find((download) =>
      ["queued", "preflighting", "downloading", "verifying"].includes(download.stage));
    if (activeDownload) {
      await services.downloads.cancel(activeDownload.id);
      response.json({ ok: true });
      return;
    }
    const cancelled = await services.runtime.cancelTask();
    response.json(cancelled ? { ok: true } : { ok: true, alreadyStopped: true });
  }));

  app.post("/api/runtime/start", asyncRoute(async (_request, response) => {
    if (services.downloads.hasActive()) throw new ModelDownloadError("Wait for the model download to finish or pause it before starting DS4", 409);
    await services.runtime.start();
    response.status(202).json({ accepted: true });
  }));

  app.post("/api/runtime/power", (_request, response) => {
    if (services.downloads.hasActive()) {
      response.status(409).json({ error: "Wait for the model download to finish or pause it before starting DS4" });
      return;
    }
    if (services.runtime.isSwitchingModel()) {
      response.status(202).json({ accepted: true, action: "working" });
      return;
    }
    const phase = services.runtime.getState().phase;
    if (["preparing", "installing", "updating", "building", "downloading", "starting", "stopping"].includes(phase)) {
      response.status(202).json({ accepted: true, action: "working" });
      return;
    }
    if (phase === "running") {
      void services.runtime.stop().catch(() => undefined);
      response.status(202).json({ accepted: true, action: "stop" });
      return;
    }
    if (!services.runtime.getState().modelPresent) {
      response.status(409).json({
        error: "No model is ready. Choose a GGUF file on this Mac or explicitly download one from the DSBox catalog."
      });
      return;
    }
    try {
      services.runtime.prepareOneClickStart();
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    void services.runtime.oneClickStart().catch((error) => {
      if (!isTaskCancelledError(error)) services.runtime.failOneClickStart(error);
    });
    response.status(202).json({ accepted: true, action: "start" });
  });

  app.post("/api/runtime/stop", asyncRoute(async (_request, response) => {
    await services.runtime.stop();
    response.json({ ok: true });
  }));

  app.post("/api/runtime/force-stop", asyncRoute(async (_request, response) => {
    await services.runtime.forceStop();
    response.json({ ok: true });
  }));

  app.post("/api/runtime/restart", asyncRoute(async (_request, response) => {
    if (services.downloads.hasActive()) throw new ModelDownloadError("Wait for the model download to finish or pause it before restarting DS4", 409);
    await services.runtime.restart();
    response.status(202).json({ accepted: true });
  }));

  app.post("/api/skills/web-search", asyncRoute(async (request, response) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      response.json(await searchWeb(String(request.body?.query ?? ""), globalThis.fetch, controller.signal));
    } catch (error) {
      if (controller.signal.aborted) return;
      response.status(502).json({ error: error instanceof Error ? error.message : "Web search failed" });
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
    }
  }));

  app.all("/api/chat", asyncRoute(async (request, response) => {
    await relayToDs4(request, response, services, "/v1/chat/completions", false, "chat");
  }));

  app.use("/v1", asyncRoute(async (request, response) => {
    await relayToDs4(request, response, services, request.originalUrl, true, "agent");
  }));

  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = path.resolve(currentDirectory, "../../dist");
  app.use(express.static(webRoot, { index: false, maxAge: "1h" }));
  app.get(/.*/, (_request, response, next) => {
    response.sendFile(path.join(webRoot, "index.html"), (error) => {
      if (error) next(error);
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = error instanceof ZodError
      ? 400
      : error instanceof ModelDownloadError || error instanceof UnsupportedInputModalityError
        ? error.status
        : 500;
    const message = error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      : error instanceof Error ? error.message : "Internal DSBox error";
    if (status >= 500) services.runtime.log("error", "dsbox", message);
    if (error instanceof UnsupportedInputModalityError) {
      response.status(status).json({
        error: {
          message,
          type: "invalid_request_error",
          code: error.code,
          modality: error.details.modality,
          location: error.details.location
        }
      });
      return;
    }
    response.status(status).json({ error: message });
  });

  return app;
}
