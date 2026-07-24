import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices, type AppServices } from "../server/app.js";

function sseResponse(records: unknown[]): Response {
  const body = records
    .map((record) => `data: ${JSON.stringify(record)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function agentEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

describe("Qwen-bound agent API", () => {
  let home: string;
  let services: AppServices;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "dsbox-agent-test-"));
    process.env.DSBOX_HOME = home;
    services = await createServices(4242);
    const config = services.store.get();
    config.model.id = "qwen3.6-35b-a3b";
    await services.store.set(config);
    const state = services.runtime.getState();
    vi.spyOn(services.runtime, "getState").mockReturnValue({
      ...state,
      phase: "running",
      readiness: "ready",
      loadedModelId: "qwen3.6-35b-a3b",
      pid: 1234
    });
  });

  afterEach(async () => {
    services.metrics.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.DSBOX_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("derives tool capability from the active runtime supported_parameters", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toMatch(/\/v1\/models$/);
      return Response.json({
        object: "list",
        data: [{
          id: "qwen3.6-35b-a3b",
          supported_parameters: ["messages", "stream", "tools", "tool_choice"]
        }]
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services)).get("/api/capabilities").expect(200);

    expect(response.body).toMatchObject({
      version: 1,
      runtime: { readiness: "ready", phase: "running", pid: 1234 },
      model: { id: "qwen3.6-35b-a3b", source: "runtime:/v1/models" },
      chat: {
        completions: true,
        streaming: true,
        tools: true,
        toolsStatus: "supported",
        streamedToolCalls: true,
        multipleToolCalls: true,
        maxSteps: 8
      },
      evidence: { source: "supported_parameters" }
    });
    expect(response.body.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "web_search",
      "runtime_status",
      "model_info"
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails Agent closed when the selected and loaded model is not Qwen", async () => {
    const config = services.store.get();
    config.model.id = "glm-5.2";
    await services.store.set(config);
    vi.mocked(services.runtime.getState).mockReturnValue({
      ...services.runtime.getState(),
      loadedModelId: "glm-5.2"
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      object: "list",
      data: [{ id: "glm-5.2", supported_parameters: ["tools"] }]
    })));

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Use an agent tool" }] })
      .expect(409);

    expect(response.body.error.code).toBe("tool_calling_unverified");
  });

  it("actively probes the runtime instead of inferring support from the model id", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({ object: "list", data: [{ id: "qwen3.6-35b-a3b" }] });
      }
      expect(url).toMatch(/\/v1\/chat\/completions$/);
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ model: "qwen3.6-35b-a3b", tool_choice: "none", max_tokens: 1 });
      expect(payload.tools).toBeInstanceOf(Array);
      return Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services)).get("/api/capabilities").expect(200);

    expect(response.body.chat).toMatchObject({ tools: true, toolsStatus: "supported" });
    expect(response.body.evidence.source).toBe("runtime_probe");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports a Qwen runtime rejection rather than enabling tools from its name", async () => {
    const config = services.store.get();
    config.model.id = "qwen3.6-35b-a3b";
    await services.store.set(config);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({ object: "list", data: [{ id: "qwen3.6-35b-a3b" }] });
      }
      return Response.json({
        error: { message: "tools are disabled until Qwen tool-call output parsing is implemented" }
      }, { status: 400 });
    });
    vi.stubGlobal("fetch", fetcher);

    const capabilities = await request(createApp(services)).get("/api/capabilities").expect(200);
    expect(capabilities.body).toMatchObject({
      model: { id: "qwen3.6-35b-a3b" },
      chat: { tools: false, toolsStatus: "unsupported" },
      evidence: { source: "runtime_probe" }
    });

    const rejected = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Check runtime" }] })
      .expect(409);
    expect(rejected.body.error).toMatchObject({ code: "tool_calling_unsupported", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { modelId: "qwen3.6-35b-a3b", reasoningField: "reasoning" }
  ] as const)(
    "runs the same canonical tool loop for $modelId and preserves call_id, reasoning, and usage",
    async ({ modelId, reasoningField }) => {
      const config = services.store.get();
      config.model.id = modelId;
      await services.store.set(config);
      let completion = 0;
      const requestBodies: Array<Record<string, unknown>> = [];
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/models")) {
          return Response.json({
            object: "list",
            data: [{ id: modelId, supported_parameters: ["stream", "tools", "tool_choice"] }]
          });
        }
        expect(url).toMatch(/\/v1\/chat\/completions$/);
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        completion += 1;
        if (completion === 1) {
          return sseResponse([
            { choices: [{ delta: { [reasoningField]: "I should inspect it." } }] },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_runtime_native_42",
                    type: "function",
                    function: { name: "runtime_status", arguments: "{" }
                  }]
                }
              }]
            },
            {
              choices: [{
                delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
                finish_reason: "tool_calls"
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            }
          ]);
        }
        return sseResponse([
          {
            choices: [{ delta: { content: "Runtime ready." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }
          }
        ]);
      });
      vi.stubGlobal("fetch", fetcher);

      const response = await request(createApp(services))
        .post("/api/agent/chat")
        .set("x-dsbox-control", "1")
        .send({
          model: modelId,
          messages: [{ role: "user", content: "Check the local runtime" }],
          max_tokens: 512
        })
        .expect(200)
        .expect("content-type", /text\/event-stream/);

      const events = agentEvents(response.text);
      expect(events.map((event) => event.type)).toEqual([
        "run.created",
        "reasoning.delta",
        "tool_call.created",
        "tool_call.arguments.delta",
        "tool_call.arguments.delta",
        "tool_call.arguments.done",
        "tool_call.started",
        "tool_call.result",
        "text.delta",
        "run.completed"
      ]);
      expect(events.filter((event) => String(event.type).startsWith("tool_call")).every(
        (event) => event.callId === "call_runtime_native_42"
      )).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: "run.completed",
        finishReason: "stop",
        steps: 2,
        usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 }
      });
      expect(response.text).toContain("data: [DONE]");
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[0]).toMatchObject({
        model: modelId,
        stream: true,
        tool_choice: "auto",
        max_tokens: 512
      });
      expect(requestBodies[0].tools).toBeInstanceOf(Array);
      expect((requestBodies[0].tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name
      )).toEqual(["runtime_status", "model_info"]);
      const secondMessages = requestBodies[1].messages as Array<Record<string, unknown>>;
      expect(secondMessages.at(-2)).toMatchObject({
        role: "assistant",
        reasoning_content: "I should inspect it.",
        tool_calls: [{ id: "call_runtime_native_42", function: { name: "runtime_status", arguments: "{}" } }]
      });
      expect(secondMessages.at(-1)).toMatchObject({
        role: "tool",
        tool_call_id: "call_runtime_native_42"
      });
      expect(JSON.parse(String(secondMessages.at(-1)?.content))).toMatchObject({
        ok: true,
        result: { phase: "running", readiness: "ready", pid: 1234 }
      });
      expect(services.activity.stage).toBe("idle");
    }
  );

  it("keeps web_search private by default and denies a hallucinated request", async () => {
    let completion = 0;
    let webRequests = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      if (url.includes("duckduckgo.com")) {
        webRequests += 1;
        return new Response("unexpected web request", { status: 500 });
      }
      completion += 1;
      const payload = JSON.parse(String(init?.body)) as {
        tools: Array<{ function: { name: string; description: string } }>;
        messages: Array<Record<string, unknown>>;
      };
      if (completion === 1) {
        expect(payload.tools.map((tool) => tool.function.name)).toEqual(["runtime_status", "model_info"]);
        return sseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_web_without_permission",
                function: { name: "web_search", arguments: "{\"query\":\"private query\"}" }
              }]
            },
            finish_reason: "tool_calls"
          }]
        }]);
      }
      expect(payload.tools.map((tool) => tool.function.name)).toEqual(["web_search", "runtime_status", "model_info"]);
      expect(payload.tools[0]?.function.description).toContain("Unavailable for this request");
      expect(JSON.parse(String(payload.messages.at(-1)?.content))).toMatchObject({
        ok: false,
        error: { code: "tool_permission_denied", retryable: false }
      });
      return sseResponse([{
        choices: [{ delta: { content: "Web search was not permitted." }, finish_reason: "stop" }]
      }]);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Search privately" }] })
      .expect(200);
    const events = agentEvents(response.text);

    expect(webRequests).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call.failed",
      callId: "call_web_without_permission",
      error: expect.objectContaining({ code: "tool_permission_denied", retryable: false })
    }));
    expect(events.some((event) => event.type === "tool_call.started")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", steps: 2 });
  });

  it("keeps historical web tool calls parseable while permission remains denied", async () => {
    let webRequests = 0;
    let completion = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({ object: "list", data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }] });
      }
      if (url.includes("duckduckgo.com")) {
        webRequests += 1;
        return new Response("unexpected web request", { status: 500 });
      }
      completion += 1;
      const payload = JSON.parse(String(init?.body)) as {
        tools: Array<{ function: { name: string; description: string } }>;
        messages: Array<Record<string, unknown>>;
      };
      const webTool = payload.tools.find((tool) => tool.function.name === "web_search");
      expect(webTool?.function.description).toContain("Unavailable for this request");
      if (completion === 1) {
        return sseResponse([{
          choices: [{
            delta: { tool_calls: [{
              index: 0,
              id: "call_historical_web",
              function: { name: "web_search", arguments: "{\"query\":\"Germany GDP 2023\"}" }
            }] },
            finish_reason: "tool_calls"
          }]
        }]);
      }
      expect(JSON.parse(String(payload.messages.at(-1)?.content))).toMatchObject({
        ok: false,
        error: { code: "tool_permission_denied" }
      });
      return sseResponse([{ choices: [{ delta: { content: "Web search is disabled." }, finish_reason: "stop" }] }]);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({
        messages: [
          { role: "user", content: "Search the weather" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_previous_web",
              type: "function",
              function: { name: "web_search", arguments: "{\"query\":\"weather\"}" }
            }]
          },
          { role: "tool", tool_call_id: "call_previous_web", content: "{\"ok\":true}" },
          { role: "assistant", content: "It was sunny." },
          { role: "user", content: "Now search Germany GDP" }
        ],
        allow_web_search: false
      })
      .expect(200);

    const events = agentEvents(response.text);
    expect(webRequests).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call.failed",
      callId: "call_historical_web",
      error: expect.objectContaining({ code: "tool_permission_denied" })
    }));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", steps: 2 });
  });

  it("runs at most three web tools concurrently and preserves result order when explicitly allowed", async () => {
    let completion = 0;
    let webRequestIndex = 0;
    let activeWebRequests = 0;
    let maxActiveWebRequests = 0;
    const delays = [35, 5, 25, 1, 10];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      if (url.includes("duckduckgo.com")) {
        const index = webRequestIndex;
        webRequestIndex += 1;
        activeWebRequests += 1;
        maxActiveWebRequests = Math.max(maxActiveWebRequests, activeWebRequests);
        await new Promise<void>((resolve) => setTimeout(resolve, delays[index]));
        activeWebRequests -= 1;
        return new Response(
          `<a class="result-link" href="https://example.com/${index}">Result ${index}</a>`
            + `<td class="result-snippet">Snippet ${index}</td>`,
          { status: 200 }
        );
      }
      completion += 1;
      const payload = JSON.parse(String(init?.body)) as {
        tools: Array<{ function: { name: string } }>;
        messages: Array<Record<string, unknown>>;
      };
      expect(payload.tools.map((tool) => tool.function.name)).toEqual([
        "web_search",
        "runtime_status",
        "model_info"
      ]);
      if (completion === 1) {
        return sseResponse([{
          choices: [{
            delta: {
              tool_calls: Array.from({ length: 5 }, (_value, index) => ({
                index,
                id: `call_web_${index}`,
                function: { name: "web_search", arguments: JSON.stringify({ query: `query ${index}` }) }
              }))
            },
            finish_reason: "tool_calls"
          }]
        }]);
      }
      expect(payload.messages.filter((message) => message.role === "tool").map(
        (message) => message.tool_call_id
      )).toEqual(["call_web_0", "call_web_1", "call_web_2", "call_web_3", "call_web_4"]);
      const toolPayloads = payload.messages
        .filter((message) => message.role === "tool")
        .map((message) => JSON.parse(String(message.content)) as {
          result: { citationFormat: string; results: Array<{ sourceId: string }> };
        });
      expect(toolPayloads.map((tool) => tool.result.results[0]?.sourceId)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
      expect(toolPayloads[0]?.result.citationFormat).toContain("[S1]");
      return sseResponse([{
        choices: [{ delta: { content: "Five searches complete." }, finish_reason: "stop" }]
      }]);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({
        allow_web_search: true,
        messages: [{ role: "user", content: "Run five independent searches" }]
      })
      .expect(200);
    const events = agentEvents(response.text);

    expect(maxActiveWebRequests).toBe(3);
    expect(events.filter((event) => event.type === "tool_call.result").map(
      (event) => event.callId
    )).toEqual(["call_web_0", "call_web_1", "call_web_2", "call_web_3", "call_web_4"]);
    expect(events.filter((event) => event.type === "tool_call.result").map(
      (event) => (event.result as { results: Array<{ sourceId: string }> }).results[0]?.sourceId
    )).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", steps: 2 });
  });

  it("validates tool arguments and returns the failure to the model for repair", async () => {
    let completion = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      completion += 1;
      if (completion === 1) {
        return sseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_bad_args",
                function: { name: "runtime_status", arguments: "{\"unexpected\":true}" }
              }]
            },
            finish_reason: "tool_calls"
          }]
        }]);
      }
      const payload = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
      const toolResult = payload.messages.at(-1);
      expect(toolResult).toMatchObject({ role: "tool", tool_call_id: "call_bad_args" });
      expect(JSON.parse(String(toolResult?.content))).toMatchObject({
        ok: false,
        error: { code: "invalid_tool_arguments", retryable: true }
      });
      return sseResponse([{ choices: [{ delta: { content: "I could not run that tool." }, finish_reason: "stop" }] }]);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Inspect it" }] })
      .expect(200);
    const events = agentEvents(response.text);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call.failed",
      callId: "call_bad_args",
      error: expect.objectContaining({ code: "invalid_tool_arguments", retryable: true })
    }));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", steps: 2 });
  });

  it("fails closed when an SSE response is empty", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Answer" }] })
      .expect(200);
    const events = agentEvents(response.text);

    expect(events.map((event) => event.type)).toEqual(["run.created", "run.error"]);
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      error: { code: "model_stream_truncated", retryable: true }
    });
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });

  it("fails closed when SSE ends after a delta without finish_reason or DONE", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Answer" }] })
      .expect(200);
    const events = agentEvents(response.text);

    expect(events.map((event) => event.type)).toEqual(["run.created", "text.delta", "run.error"]);
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      error: { code: "model_stream_truncated", retryable: true }
    });
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });

  it("fails the run when the runtime reports a generated-protocol error", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      return sseResponse([{
        choices: [{ delta: {}, finish_reason: "error" }]
      }]);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Call a tool" }] })
      .expect(200);
    const events = agentEvents(response.text);

    expect(events.map((event) => event.type)).toEqual(["run.created", "run.error"]);
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      error: { code: "model_generation_failed", retryable: true }
    });
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });

  it("rejects more than eight tool calls in one turn before executing any", async () => {
    let completions = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      completions += 1;
      return sseResponse([{
        choices: [{
          delta: {
            tool_calls: Array.from({ length: 9 }, (_value, index) => ({
              index,
              id: `call_overflow_${index}`,
              function: { name: "runtime_status", arguments: "{}" }
            }))
          },
          finish_reason: "tool_calls"
        }]
      }]);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Fan out" }] })
      .expect(200);
    const events = agentEvents(response.text);

    expect(completions).toBe(1);
    expect(events.some((event) => ["tool_call.started", "tool_call.result", "tool_call.failed"].includes(
      String(event.type)
    ))).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      error: { code: "tool_call_limit_exceeded", retryable: false }
    });
  });

  it("rejects the twenty-fifth tool call before executing its turn", async () => {
    let completion = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      completion += 1;
      const count = completion <= 3 ? 8 : 1;
      return sseResponse([{
        choices: [{
          delta: {
            tool_calls: Array.from({ length: count }, (_value, index) => ({
              index,
              id: `call_run_${completion}_${index}`,
              function: { name: "runtime_status", arguments: "{}" }
            }))
          },
          finish_reason: "tool_calls"
        }]
      }]);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Use too many tools" }] })
      .expect(200);
    const events = agentEvents(response.text);

    expect(completion).toBe(4);
    expect(events.filter((event) => event.type === "tool_call.result")).toHaveLength(24);
    expect(events.some((event) => event.type === "tool_call.result" && event.callId === "call_run_4_0")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      error: { code: "tool_run_limit_exceeded", retryable: false }
    });
  });

  it("stops after eight tool rounds", async () => {
    let completion = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      completion += 1;
      return sseResponse([{
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_loop_${completion}`,
              function: { name: "runtime_status", arguments: "{}" }
            }]
          },
          finish_reason: "tool_calls"
        }]
      }]);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await request(createApp(services))
      .post("/api/agent/chat")
      .set("x-dsbox-control", "1")
      .send({ messages: [{ role: "user", content: "Keep checking forever" }] })
      .expect(200);
    const events = agentEvents(response.text);

    expect(completion).toBe(9);
    expect(events.filter((event) => event.type === "tool_call.result")).toHaveLength(8);
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      step: 9,
      error: { code: "max_steps_exceeded", retryable: false }
    });
  });

  it("aborts the active model request when the client disconnects", async () => {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "qwen3.6-35b-a3b", supported_parameters: ["tools"] }]
        });
      }
      markStarted();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Missing upstream abort signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          markAborted();
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const gateway = createApp(services).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => gateway.once("listening", resolve));
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("Agent test gateway did not bind");

    try {
      const client = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/agent/chat",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dsbox-control": "1"
        }
      });
      client.on("error", () => undefined);
      client.end(JSON.stringify({ messages: [{ role: "user", content: "Wait" }] }));
      await started;
      client.destroy();
      await aborted;
      await vi.waitFor(() => expect(services.activity.stage).toBe("idle"));
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });
});
