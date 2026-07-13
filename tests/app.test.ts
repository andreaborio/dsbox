import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices, type AppServices } from "../server/app.js";
import type { CatalogModel } from "../src/types.js";

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

  it("starts the recommended DSBox model through the power endpoint without spawning work in the request", async () => {
    const recommended: CatalogModel = {
      repository: "andreaborio/deepseek-v4-flash-ds4-metal",
      revision: "0123456789abcdef0123456789abcdef01234567",
      label: "DeepSeek V4 Flash per DSBox",
      description: "Profilo verificato da DSBox.",
      modelId: "deepseek-v4-flash",
      runtimeBranch: "main",
      runtimeCommit: "d".repeat(40),
      files: [{ name: "model.gguf", sizeBytes: 1024, sha256: "sha256" }],
      outputFile: "model.gguf",
      totalBytes: 1024,
      recommended: true,
      experimental: false,
      installable: true,
      minimumMemoryGb: 64,
      lastModified: "2026-07-12T10:00:00.000Z",
      sourceUrl: "https://huggingface.co/andreaborio/deepseek-v4-flash-ds4-metal",
      unavailableReason: null
    };
    vi.spyOn(services.catalog, "list").mockResolvedValue({
      author: "andreaborio",
      label: "Modelli DSBox",
      models: [recommended],
      recommended,
      refreshedAt: "2026-07-12T10:00:00.000Z",
      stale: false
    });
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
    expect(oneClickStart).toHaveBeenCalledWith(recommended);
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
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ciao" } }] })}\n\n`);
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
    expect(response.text).toContain('"content":"ciao"');
    expect(response.text).toContain("data: [DONE]");
    expect(activityStages).toContain("prefill");
    expect(activityStages).toContain("decode");
    expect(activityStages.at(-1)).toBe("idle");
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
