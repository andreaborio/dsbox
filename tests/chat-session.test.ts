import { describe, expect, it, vi } from "vitest";
import { ChatSessionStore, shouldAutoEnableWebSearch, type ChatStorage } from "../src/lib/chat-session.js";

class MemoryStorage implements ChatStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function ids() {
  let next = 1;
  return () => `id-${next++}`;
}

function frame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

describe("persistent chat session", () => {
  it("routes only explicit or time-sensitive prompts to web search in auto mode", () => {
    expect(shouldAutoEnableWebSearch("What is the latest stable Rust release?")).toBe(true);
    expect(shouldAutoEnableWebSearch("Cerca sul web le notizie di oggi")).toBe(true);
    expect(shouldAutoEnableWebSearch("Summarize https://modelcontextprotocol.io/docs")).toBe(true);
    expect(shouldAutoEnableWebSearch("Refactor the current function without changing behavior")).toBe(false);
    expect(shouldAutoEnableWebSearch("Explain this private stack trace")).toBe(false);
  });

  it("keeps streaming without a mounted view and records server usage and timing", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let currentTime = 1_000;
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; }
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const store = new ChatSessionStore({ fetcher, storage: new MemoryStorage(), now: () => currentTime, createId: ids() });
    const firstView = vi.fn();
    const unsubscribe = store.subscribe(firstView);

    const completion = store.send({ content: "Explain the hot path", model: "test", maxTokens: 1024 });
    await vi.waitFor(() => expect(store.getSnapshot().streaming).toBe(true));
    unsubscribe();

    const reasoning = frame({ choices: [{ delta: { reasoning_content: "thinking" } }] });
    currentTime = 1_800;
    streamController.enqueue(reasoning.slice(0, 19));
    streamController.enqueue(reasoning.slice(19));
    await vi.waitFor(() => expect(store.getSnapshot().messages.at(-1)?.reasoning).toBe("thinking"));

    currentTime = 3_000;
    streamController.enqueue(frame({ choices: [{ delta: { content: "Hello" } }] }));
    await vi.waitFor(() => expect(store.getSnapshot().messages.at(-1)?.content).toBe("Hello"));
    streamController.enqueue(frame({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, completion_tokens_details: { reasoning_tokens: 4 } },
      timings: { prompt_n: 100, prompt_ms: 500, prompt_per_second: 200, predicted_n: 10, predicted_ms: 1_000, predicted_per_second: 10 }
    }));
    currentTime = 4_200;
    streamController.close();
    await completion;

    const state = store.getSnapshot();
    const assistant = state.messages.at(-1)!;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.streaming).toBe(false);
    expect(assistant.content).toBe("Hello");
    expect(assistant.reasoning).toBe("thinking");
    expect(assistant.pending).toBe(false);
    expect(assistant.stats).toMatchObject({
      promptTokens: 100,
      completionTokens: 10,
      reasoningTokens: 4,
      totalTokens: 110,
      prefillMs: 500,
      thinkingMs: 1_200,
      decodeMs: 1_000,
      totalMs: 3_200,
      prefillTokensPerSecond: 200,
      averageTokensPerSecond: 10,
      timingSource: "server"
    });
  });

  it("can stop the original generation after the chat view returns", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal: AbortSignal | null = null;
    let wasAborted = false;
    const fetcher = vi.fn(async (_input: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
      requestSignal.addEventListener("abort", () => {
        wasAborted = true;
        const error = new Error("Aborted");
        error.name = "AbortError";
        streamController.error(error);
      }, { once: true });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const store = new ChatSessionStore({ fetcher, storage: new MemoryStorage(), createId: ids() });
    const completion = store.send({ content: "Loop forever", model: "test", maxTokens: 1024 });
    await vi.waitFor(() => expect(store.getSnapshot().streaming).toBe(true));
    streamController.enqueue(frame({ choices: [{ delta: { content: "partial output" } }] }));
    await vi.waitFor(() => expect(store.getSnapshot().messages.at(-1)?.content).toBe("partial output"));

    const returnedView = vi.fn();
    const unsubscribe = store.subscribe(returnedView);
    store.stop();
    await completion;
    unsubscribe();

    const assistant = store.getSnapshot().messages.at(-1)!;
    expect(wasAborted).toBe(true);
    expect(requestSignal).not.toBeNull();
    expect(store.getSnapshot().streaming).toBe(false);
    expect(assistant.content).toBe("partial output");
    expect(assistant.interrupted).toBe(true);
    expect(assistant.pending).toBe(false);
  });

  it("stores, switches, and deletes local threads", async () => {
    const storage = new MemoryStorage();
    const fetcher = vi.fn(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));
    const store = new ChatSessionStore({ fetcher, storage, createId: ids() });
    await store.send({ content: "First local thread", model: "test", maxTokens: 32 });
    const firstId = store.getSnapshot().activeThreadId;
    const secondId = store.newThread();
    await store.send({ content: "Second local thread", model: "test", maxTokens: 32 });

    expect(store.getSnapshot().threads).toHaveLength(2);
    expect(store.selectThread(firstId)).toBe(true);
    expect(store.getSnapshot().messages[0]?.content).toBe("First local thread");
    expect(store.renameThread(firstId, "Renamed thread")).toBe(true);
    expect(store.getSnapshot().threads.find((thread) => thread.id === firstId)?.title).toBe("Renamed thread");
    expect(store.deleteThread(secondId)).toBe(true);
    expect(store.getSnapshot().threads).toHaveLength(1);

    const restored = new ChatSessionStore({ fetcher, storage, createId: ids() });
    expect(restored.getSnapshot().threads).toHaveLength(1);
    expect(restored.getSnapshot().messages[0]?.content).toBe("First local thread");
  });

  it("runs enabled web search before inference and keeps visible sources", async () => {
    let currentTime = 1_000;
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string, init: RequestInit) => {
      requests.push({ input, init });
      if (input === "/api/skills/web-search") {
        currentTime = 1_500;
        return Response.json({
          provider: "DuckDuckGo",
          results: [{ title: "Current reference", url: "https://example.com/current", snippet: "Fresh context" }]
        });
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answer [1]" } }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })}\n\ndata: [DONE]\n\n`, { status: 200 });
    });
    const store = new ChatSessionStore({ fetcher, storage: new MemoryStorage(), now: () => currentTime, createId: ids() });
    await store.send({ content: "Search the web for what changed", model: "test", maxTokens: 128 });

    const assistant = store.getSnapshot().messages.at(-1)!;
    expect(requests.map((request) => request.input)).toEqual(["/api/skills/web-search", "/api/chat"]);
    expect(JSON.parse(String(requests[1].init.body)).messages).toContainEqual(expect.objectContaining({ role: "system", content: expect.stringContaining("https://example.com/current") }));
    expect(assistant.sources).toEqual([{ title: "Current reference", url: "https://example.com/current", snippet: "Fresh context" }]);
    expect(assistant.stats?.webSearchMs).toBe(500);
  });

  it("automatically searches for a freshness-sensitive prompt and stays local otherwise", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: string) => {
      requests.push(input);
      if (input === "/api/skills/web-search") {
        return Response.json({ results: [{ title: "Release", url: "https://example.com/release", snippet: "Current release" }] });
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    });
    const store = new ChatSessionStore({ fetcher, storage: new MemoryStorage(), createId: ids() });

    await store.send({ content: "What is the latest release?", model: "test", maxTokens: 32 });
    expect(requests).toEqual(["/api/skills/web-search", "/api/chat"]);

    requests.length = 0;
    await store.send({ content: "Explain this local function", model: "test", maxTokens: 32 });
    expect(requests).toEqual(["/api/chat"]);
  });

  it("falls back to local inference when an automatic search is unavailable", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: string) => {
      requests.push(input);
      if (input === "/api/skills/web-search") return Response.json({ error: "offline" }, { status: 503 });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "local answer" } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    });
    const store = new ChatSessionStore({ fetcher, storage: new MemoryStorage(), createId: ids() });

    await store.send({ content: "What is the latest release?", model: "test", maxTokens: 32 });

    expect(requests).toEqual(["/api/skills/web-search", "/api/chat"]);
    expect(store.getSnapshot().messages.at(-1)).toMatchObject({
      content: "local answer",
      skillNotice: "Web search was unavailable, so DSBox continued locally."
    });
  });
});
