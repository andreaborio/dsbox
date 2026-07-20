import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../server/config.js";
import type { ConfigStore } from "../server/config.js";
import { EventBus } from "../server/event-bus.js";
import { shellDisplayArgument } from "../src/lib/arguments.js";
import type { CatalogModel, DsboxConfig, LocalModelCandidate } from "../src/types.js";
import {
  buildEngineArguments,
  ds4BuildInfoMatchesHead,
  EXPERT_MAJOR_RUNTIME_COMMIT,
  GLM52_RUNTIME_BRANCH,
  GLM52_RUNTIME_COMMIT,
  orderedLocalModelScanRoots,
  parseEnvironment,
  parseFallbackModelFilename,
  parseVmStatSwapoutPages,
  qwen35LaunchEnvironment,
  QWEN35_RUNTIME_BRANCH,
  QWEN35_RUNTIME_COMMIT,
  remainingDownloadBytes,
  RuntimeManager,
  tokenizeArguments
} from "../server/runtime.js";

describe("local model scan roots", () => {
  it("checks visible home-folder siblings before caches and external volumes", () => {
    const roots = orderedLocalModelScanRoots(
      "/Users/alice/.dsbox/models/current/model.gguf",
      "/Users/alice/.dsbox",
      "/Users/alice"
    );

    expect(roots).toContain("/Users/alice");
    expect(roots.indexOf("/Users/alice")).toBeLessThan(roots.indexOf("/Users/alice/.cache/huggingface/hub"));
    expect(roots.indexOf("/Users/alice")).toBeLessThan(roots.indexOf("/Volumes"));
  });
});

describe("argument tokenizer", () => {
  it("preserves quoted values without invoking a shell", () => {
    expect(tokenizeArguments(`--trace "/tmp/path with spaces/trace.log" --flag='hello world'`)).toEqual([
      "--trace",
      "/tmp/path with spaces/trace.log",
      "--flag=hello world"
    ]);
  });

  it("keeps shell metacharacters inert as plain argv data", () => {
    expect(tokenizeArguments("--system '$(touch /tmp/never)' --other '; rm -rf /'" )).toEqual([
      "--system",
      "$(touch /tmp/never)",
      "--other",
      "; rm -rf /"
    ]);
  });

  it("rejects unclosed quotes", () => {
    expect(() => tokenizeArguments(`--trace "broken`)).toThrow(/quotation mark/);
  });

  it("renders copied argv without executing shell metacharacters", () => {
    expect(shellDisplayArgument("$(touch /tmp/never)")).toBe("'$(touch /tmp/never)'");
    expect(shellDisplayArgument("O'Brien.gguf")).toBe("'O'\\''Brien.gguf'");
    expect(tokenizeArguments(shellDisplayArgument("O'Brien.gguf"))).toEqual(["O'Brien.gguf"]);
  });
});

describe("environment parser", () => {
  it("accepts comments and values containing equals signs", () => {
    expect(parseEnvironment("# diagnostics\nDS4_METAL_MEMORY_REPORT=1\nTOKEN=a=b=c\n")).toEqual({
      DS4_METAL_MEMORY_REPORT: "1",
      TOKEN: "a=b=c"
    });
  });

  it("rejects invalid names", () => {
    expect(() => parseEnvironment("BAD-NAME=1")).toThrow(/variable name/);
  });

  it("forces the Qwen Metal gate and removes unsupported inherited tuning", () => {
    expect(qwen35LaunchEnvironment({
      PATH: "/usr/bin",
      DS4_EXPERT_PROFILE: "/tmp/profile.json",
      DS4_METAL_STREAMING_PIN_NON_ROUTED: "1",
      DS4_METAL_STREAMING_EXPERT_HOTLIST_PRIORITY: "1",
      DS4_SERVER_STREAMING_DECODE_STATS: "1",
      DS4_QWEN_EXPERIMENTAL_METAL: "0"
    }, {
      DS4_EXPERT_HOTLIST: "1,2,3",
      CUSTOM_VALUE: "kept"
    })).toMatchObject({
      PATH: "/usr/bin",
      CUSTOM_VALUE: "kept",
      DS4_QWEN_EXPERIMENTAL_METAL: "1"
    });
    const environment = qwen35LaunchEnvironment({ DS4_EXPERT_PROFILE: "x" }, { DS4_EXPERT_HOTLIST: "y" });
    expect(environment.DS4_EXPERT_PROFILE).toBeUndefined();
    expect(environment.DS4_EXPERT_HOTLIST).toBeUndefined();
    expect(qwen35LaunchEnvironment({}, { DS4_METAL_STREAMING_EXPERT_HOTLIST_PRIORITY: "1" }).DS4_METAL_STREAMING_EXPERT_HOTLIST_PRIORITY).toBeUndefined();
    expect(qwen35LaunchEnvironment({ DS4_SERVER_STREAMING_DECODE_STATS: "1" }, {}).DS4_SERVER_STREAMING_DECODE_STATS).toBeUndefined();
  });
});

describe("DS4 build identity", () => {
  it("accepts only a binary revision that prefixes the current checkout HEAD", () => {
    const head = "91d311d580b0ddb4e1b68c86dea6f0232a12f485";
    expect(ds4BuildInfoMatchesHead("ds4 build\ngit:     91d311d580b0\nbackend: metal\n", head)).toBe(true);
    expect(ds4BuildInfoMatchesHead("git: 1523b2681eef\n", head)).toBe(false);
    expect(ds4BuildInfoMatchesHead("git: unknown\n", head)).toBe(false);
  });
});

describe("resumable fallback downloads", () => {
  it("reads the selected GGUF filename without executing the download script", () => {
    const script = `Q2_IMATRIX_FILE="flash-q2.gguf"\nQ4_IMATRIX_FILE='flash-q4.gguf'\n`;
    expect(parseFallbackModelFilename(script, "q2-imatrix")).toBe("flash-q2.gguf");
    expect(parseFallbackModelFilename(script, "q4-imatrix")).toBe("flash-q4.gguf");
  });

  it("preflights only the bytes still missing from a partial download", () => {
    const estimated = 81 * 1024 ** 3;
    expect(remainingDownloadBytes(estimated, 60 * 1024 ** 3)).toBe(21 * 1024 ** 3);
    expect(remainingDownloadBytes(estimated, estimated + 1)).toBe(0);
  });
});

describe("engine arguments", () => {
  it("uses the bounded 16 GB profile and leaves cache sizing to DS4", () => {
    const config = createDefaultConfig(16 * 1024 ** 3);
    const args = buildEngineArguments(config);
    expect(args.slice(args.indexOf("--ctx"), args.indexOf("--ctx") + 2)).toEqual(["--ctx", "8192"]);
    expect(args.slice(args.indexOf("--tokens"), args.indexOf("--tokens") + 2)).toEqual(["--tokens", "4096"]);
    expect(args).toContain("--ssd-streaming");
    expect(args).not.toContain("--ssd-streaming-cache-experts");
    expect(args.slice(args.indexOf("--power"), args.indexOf("--power") + 2)).toEqual(["--power", "100"]);
  });

  it("uses DS4 adaptive cache sizing on the 64 GB profile", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    const args = buildEngineArguments(config);
    expect(args).toContain("--metal");
    expect(args).toContain("--ssd-streaming");
    expect(args).not.toContain("--ssd-streaming-cache-experts");
    expect(args).toContain("--kv-disk-dir");
    expect(args).not.toContain("--chdir");
    expect(args).not.toContain("--cors");
    expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2)).toEqual(["--host", "127.0.0.1"]);
  });

  it("delegates unmeasured hardware and models to DS4 AUTO", () => {
    const config = createDefaultConfig(128 * 1024 ** 3);
    expect(config.streaming.cacheMode).toBe("auto");
    expect(buildEngineArguments(config)).not.toContain("--ssd-streaming-cache-experts");
    const glm = createDefaultConfig(64 * 1024 ** 3);
    glm.model.id = "glm-5.2";
    glm.model.path = "/models/glm-5.2.gguf";
    glm.streaming.cacheMode = "manual";
    glm.streaming.cacheSizeGb = 32;
    glm.streaming.coldStart = true;
    glm.streaming.preloadExperts = 528;
    const glmArgs = buildEngineArguments(glm);
    expect(glmArgs).not.toContain("--ssd-streaming");
    expect(glmArgs).not.toContain("--ssd-streaming-cache-experts");
    expect(glmArgs).not.toContain("--ssd-streaming-cold");
    expect(glmArgs).not.toContain("--ssd-streaming-preload-experts");
  });

  it("preserves manual GB and advanced exact overrides without duplicates", () => {
    const manual = createDefaultConfig(64 * 1024 ** 3);
    manual.streaming.cacheMode = "manual";
    manual.streaming.cacheSizeGb = 32;
    expect(buildEngineArguments(manual)).toContain("32GB");

    const advanced = createDefaultConfig(16 * 1024 ** 3);
    advanced.advanced.extraArgs = "--ssd-streaming-cache-experts 300";
    const args = buildEngineArguments(advanced);
    expect(args.filter((value) => value === "--ssd-streaming-cache-experts")).toHaveLength(1);
    expect(args).toContain("300");

    advanced.advanced.extraArgs = "--ssd-streaming-cache-experts=301";
    const equalsArgs = buildEngineArguments(advanced);
    expect(equalsArgs).not.toContain("--ssd-streaming-cache-experts");
    expect(equalsArgs).toContain("--ssd-streaming-cache-experts=301");
  });

  it("parses the cumulative macOS swapout counter", () => {
    expect(parseVmStatSwapoutPages("Swapouts: 2010446.\n")).toBe(2_010_446);
    expect(parseVmStatSwapoutPages("Pages free: 10.\n")).toBeNull();
  });

  it("adds privacy-sensitive diagnostics only when enabled", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.observability.traceEnabled = true;
    config.observability.imatrixEnabled = true;
    const args = buildEngineArguments(config);
    expect(args).toContain("--trace");
    expect(args).toContain("--imatrix-out");
    expect(args).toContain("--imatrix-every");
  });

  it("applies the exact Qwen Metal AUTO residency profile", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.model.id = "qwen3.6-35b-a3b";
    config.model.path = "/models/Qwen3.6-35B-A3B-ds4-Q4_K_S.gguf";
    config.server.powerPercent = 48;
    config.server.quality = true;
    config.server.warmWeights = true;
    config.streaming.cacheMode = "manual";
    config.streaming.cacheSizeGb = 24;
    config.streaming.preloadExperts = 512;
    config.observability.imatrixEnabled = true;
    config.advanced.extraArgs = [
      "--power 12",
      "--quality",
      "--ssd-streaming",
      "--ssd-streaming-cold",
      "--ssd-streaming-cache-experts 700",
      "--ssd-streaming-preload-experts 200",
      "--mtp /models/draft.gguf",
      "--role coordinator",
      "--listen 127.0.0.1 9000",
      "--dir-steering-file /tmp/steer.bin",
      "--kv-disk-dir /tmp/custom-kv",
      "--trace /tmp/qwen.trace"
    ].join(" ");

    const args = buildEngineArguments(config);
    expect(args.slice(args.indexOf("--power"), args.indexOf("--power") + 2)).toEqual(["--power", "100"]);
    expect(args).toContain("--metal");
    expect(args).not.toContain("--ssd-streaming");
    expect(args).not.toContain("--ssd-streaming-cold");
    expect(args).toContain("--trace");
    expect(args).not.toContain("--quality");
    expect(args).not.toContain("--warm-weights");
    expect(args).not.toContain("--ssd-streaming-cache-experts");
    expect(args).not.toContain("--ssd-streaming-preload-experts");
    expect(args).not.toContain("--imatrix-out");
    expect(args).not.toContain("--mtp");
    expect(args).not.toContain("--role");
    expect(args).not.toContain("--listen");
    expect(args).not.toContain("--dir-steering-file");
    expect(args).not.toContain("--kv-disk-dir");
    expect(args).not.toContain("/tmp/custom-kv");
    expect(args).not.toContain("/models/draft.gguf");
    expect(args.filter((value) => value === "127.0.0.1")).toHaveLength(1);
  });

  it("uses verified architecture instead of a misleading configured model id", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.model.id = "qwen3.6-35b-a3b";
    config.server.quality = true;

    expect(buildEngineArguments(config, "deepseek4")).toContain("--quality");
    expect(buildEngineArguments(config, "qwen35moe")).not.toContain("--quality");
  });
});

describe("Qwen one-click preparation", () => {
  it("replaces an older Qwen-capable checkout with the qualified optimized runtime", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.repository.directory = "/work/ds4-qwen-support";
    config.repository.branch = "feat/qwen-support";
    config.model = {
      path: "/models/Qwen3.6-35B-A3B-ds4-Q4_K_S.gguf",
      id: "qwen3.6-35b-a3b"
    };
    let current = structuredClone(config);
    const store = {
      homeDirectory: "/home/alice/.dsbox",
      get: vi.fn(() => structuredClone(current)),
      set: vi.fn(async (next: DsboxConfig) => {
        current = structuredClone(next);
        return structuredClone(current);
      })
    } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const internal = runtime as unknown as {
      checkoutHasQualifiedQwenRuntime(directory: string): Promise<boolean>;
      binaryHasQwenRuntime(directory: string): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
      ensureQwenRuntimeCheckout(config: DsboxConfig): Promise<DsboxConfig>;
    };
    vi.spyOn(internal, "checkoutHasQualifiedQwenRuntime").mockImplementation(async (directory) => directory === "/work/ds4-qwen-metal-opt");
    vi.spyOn(internal, "binaryHasQwenRuntime").mockResolvedValue(true);
    vi.spyOn(internal, "binaryMatchesCheckoutHead").mockResolvedValue(true);
    vi.spyOn(runtime, "discoveredCheckouts").mockResolvedValue([
      { path: "/work/ds4-qwen-support", branch: "feat/qwen-support", head: "91d311d58" },
      { path: "/work/ds4-qwen-metal-opt", branch: QWEN35_RUNTIME_BRANCH, head: QWEN35_RUNTIME_COMMIT.slice(0, 9) }
    ]);
    vi.spyOn(runtime, "refresh").mockResolvedValue(runtime.getState());

    const selected = await internal.ensureQwenRuntimeCheckout(config);

    expect(QWEN35_RUNTIME_COMMIT).toMatch(/^[a-f0-9]{40}$/);
    expect(selected.repository).toMatchObject({
      directory: "/work/ds4-qwen-metal-opt",
      branch: QWEN35_RUNTIME_BRANCH
    });
    expect(store.set).toHaveBeenCalledOnce();
  });

  it("selects the Qwen-capable checkout before considering the default runtime install", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.model = {
      path: "/models/Qwen3.6-35B-A3B-ds4-Q4_K_S.gguf",
      id: "qwen3.6-35b-a3b"
    };
    const store = {
      get: vi.fn(() => structuredClone(config))
    } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const initial = { ...runtime.getState(), phase: "uninstalled" as const, modelPresent: true, installed: false, built: false };
    const ready = { ...initial, phase: "idle" as const, installed: true, built: true };
    const candidate: LocalModelCandidate = {
      path: config.model.path,
      name: "Qwen3.6-35B-A3B-ds4-Q4_K_S",
      sizeBytes: 20_808_563_424,
      modelId: config.model.id,
      selected: true,
      compatibility: { status: "compatible", code: "ds4_native", reason: null },
      architecture: "qwen35moe"
    };
    vi.spyOn(runtime, "refresh").mockResolvedValueOnce(initial).mockResolvedValue(ready);
    vi.spyOn(runtime, "validateLocalModel").mockResolvedValue(candidate);
    const internal = runtime as unknown as {
      ensureQwenRuntimeCheckout(config: DsboxConfig): Promise<DsboxConfig>;
    };
    const prepareQwen = vi.spyOn(internal, "ensureQwenRuntimeCheckout").mockResolvedValue(config);
    const install = vi.spyOn(runtime, "installOrUpdate").mockResolvedValue();
    const build = vi.spyOn(runtime, "build").mockResolvedValue();
    const start = vi.spyOn(runtime, "start").mockResolvedValue();

    await runtime.oneClickStart();

    expect(prepareQwen).toHaveBeenCalledWith(config);
    expect(install).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps Qwen ExpertMajor v1 off the legacy tool branch and requires the unified main ancestry", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.repository.branch = QWEN35_RUNTIME_BRANCH;
    config.repository.directory = "/work/ds4-qwen-tool-legacy";
    let current = structuredClone(config);
    const store = {
      homeDirectory: "/home/alice/.dsbox",
      get: vi.fn(() => structuredClone(current)),
      set: vi.fn(async (next: DsboxConfig) => {
        current = structuredClone(next);
        return structuredClone(current);
      })
    } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const ancestryChecks: string[][] = [];
    const internal = runtime as unknown as {
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v1",
        allowModelSwitch?: boolean
      ): Promise<DsboxConfig>;
      runtimeIncludesCommits(directory: string, commits: readonly string[]): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
      binaryHasQwenRuntime(directory: string): Promise<boolean>;
    };
    vi.spyOn(runtime, "discoveredCheckouts").mockResolvedValue([]);
    vi.spyOn(internal, "runtimeIncludesCommits").mockImplementation(async (directory, commits) => {
      ancestryChecks.push([...commits]);
      return directory === "/home/alice/.dsbox/runtime/andreaborio-ds4";
    });
    vi.spyOn(internal, "binaryMatchesCheckoutHead").mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(internal, "binaryHasQwenRuntime").mockResolvedValue(true);
    vi.spyOn(runtime, "refresh").mockResolvedValue(runtime.getState());
    const install = vi.spyOn(runtime, "installOrUpdate").mockResolvedValue();
    const build = vi.spyOn(runtime, "build").mockResolvedValue();

    const selected = await internal.ensureExpertMajorRuntimeCheckout(config, "ds4-expert-major-v1", true);

    expect(selected.repository).toMatchObject({
      url: "https://github.com/andreaborio/ds4.git",
      branch: "main",
      directory: "/home/alice/.dsbox/runtime/andreaborio-ds4"
    });
    expect(ancestryChecks).not.toHaveLength(0);
    expect(ancestryChecks.every((commits) => commits.length === 1)).toBe(true);
    expect(ancestryChecks.every((commits) => commits.includes(EXPERT_MAJOR_RUNTIME_COMMIT))).toBe(true);
    expect(install).toHaveBeenCalledWith(true);
    expect(build).toHaveBeenCalledWith(true);
  });

  it("qualifies GLM ExpertMajor v2 from explicit source and current-binary capabilities", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.repository.directory = "/work/ds4-glm-expert-major";
    const store = { get: vi.fn(() => structuredClone(config)) } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const internal = runtime as unknown as {
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
      checkoutHasGlmExpertMajorV2Source(directory: string): Promise<boolean>;
      binaryHasGlmExpertMajorV2Runtime(directory: string): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
      runtimeIncludesCommit(directory: string, commit: string): Promise<boolean>;
    };
    const sourceCapability = vi.spyOn(internal, "checkoutHasGlmExpertMajorV2Source").mockResolvedValue(true);
    const binaryCapability = vi.spyOn(internal, "binaryHasGlmExpertMajorV2Runtime").mockResolvedValue(true);
    vi.spyOn(internal, "binaryMatchesCheckoutHead").mockResolvedValue(true);
    const pinnedAncestry = vi.spyOn(internal, "runtimeIncludesCommit").mockResolvedValue(true);
    const install = vi.spyOn(runtime, "installOrUpdate").mockResolvedValue();
    const build = vi.spyOn(runtime, "build").mockResolvedValue();

    const selected = await internal.ensureExpertMajorRuntimeCheckout(
      config,
      "ds4-expert-major-v2",
      false,
      "glm-dsa"
    );

    expect(selected.repository.directory).toBe(config.repository.directory);
    expect(sourceCapability).toHaveBeenCalledWith(config.repository.directory);
    expect(binaryCapability).toHaveBeenCalledWith(config.repository.directory);
    expect(pinnedAncestry).toHaveBeenCalledWith(config.repository.directory, GLM52_RUNTIME_COMMIT);
    expect(install).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("installs the unified qualified main runtime when no usable GLM checkout exists", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.repository = {
      url: "https://example.com/retired-glm-runtime.git",
      branch: "retired-glm-runtime",
      directory: "/work/retired-glm-runtime"
    };
    let current = structuredClone(config);
    const store = {
      homeDirectory: "/home/alice/.dsbox",
      get: vi.fn(() => structuredClone(current)),
      set: vi.fn(async (next: DsboxConfig) => {
        current = structuredClone(next);
        return structuredClone(current);
      })
    } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const targetDirectory = "/home/alice/.dsbox/runtime/andreaborio-ds4";
    const internal = runtime as unknown as {
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
      checkoutHasGlmExpertMajorV2Source(directory: string): Promise<boolean>;
      runtimeIncludesCommit(directory: string, commit: string): Promise<boolean>;
      binaryHasGlmExpertMajorV2Runtime(directory: string): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
    };
    vi.spyOn(runtime, "discoveredCheckouts").mockResolvedValue([]);
    vi.spyOn(internal, "checkoutHasGlmExpertMajorV2Source")
      .mockImplementation(async (directory) => directory === targetDirectory);
    vi.spyOn(internal, "runtimeIncludesCommit")
      .mockImplementation(async (directory, commit) => directory === targetDirectory && commit === GLM52_RUNTIME_COMMIT);
    vi.spyOn(internal, "binaryHasGlmExpertMajorV2Runtime").mockResolvedValue(true);
    vi.spyOn(internal, "binaryMatchesCheckoutHead").mockResolvedValue(true);
    vi.spyOn(runtime, "refresh").mockResolvedValue(runtime.getState());
    const install = vi.spyOn(runtime, "installOrUpdate").mockResolvedValue();

    const selected = await internal.ensureExpertMajorRuntimeCheckout(
      config,
      "ds4-expert-major-v2",
      false,
      "glm-dsa"
    );

    expect(selected.repository).toMatchObject({
      url: "https://github.com/andreaborio/ds4.git",
      branch: GLM52_RUNTIME_BRANCH,
      directory: targetDirectory
    });
    expect(GLM52_RUNTIME_COMMIT).toMatch(/^[a-f0-9]{40}$/);
    expect(GLM52_RUNTIME_BRANCH).toBe("main");
    expect(install).toHaveBeenCalledWith(false);
  });

  it("passes the transactional switch allowance into runtime preparation", async () => {
    const runtime = new RuntimeManager({} as ConfigStore, new EventBus());
    const internal = runtime as unknown as {
      startManaged(modelSwitch?: boolean): Promise<void>;
      startEngine(modelSwitch?: boolean): Promise<void>;
    };
    const startEngine = vi.spyOn(internal, "startEngine").mockResolvedValue();

    await internal.startManaged(true);

    expect(startEngine).toHaveBeenCalledWith(true);
  });

  it("keeps public runtime mutations blocked during a switch but permits the internal transaction", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    const store = { get: vi.fn(() => structuredClone(config)) } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const internal = runtime as unknown as {
      modelSwitchPending: boolean;
      pathExists(candidate: string, executable?: boolean): Promise<boolean>;
    };
    internal.modelSwitchPending = true;
    vi.spyOn(internal, "pathExists").mockRejectedValue(new Error("passed the switch guard"));

    await expect(runtime.installOrUpdate()).rejects.toThrow("Stop the runtime before updating");
    await expect(runtime.installOrUpdate(true)).rejects.toThrow("passed the switch guard");
    await expect(runtime.build()).rejects.toThrow("Stop the runtime before building");
    await expect(runtime.build(true)).rejects.toThrow("passed the switch guard");
  });

  it("prepares the full ExpertMajor runtime policy before a catalog download", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    const store = { get: vi.fn(() => structuredClone(config)) } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const model = { artifactFormat: "ds4-expert-major-v1" } as CatalogModel;
    const internal = runtime as unknown as {
      ensureCatalogRuntime(model: CatalogModel): Promise<void>;
      ensureExpertMajorRuntimeCheckout(config: DsboxConfig, format: "ds4-expert-major-v1"): Promise<DsboxConfig>;
    };
    let expertMajorPrepared = false;
    const fullPolicy = vi.spyOn(internal, "ensureExpertMajorRuntimeCheckout").mockImplementation(async () => {
      expertMajorPrepared = true;
      return config;
    });
    const pinRuntime = vi.spyOn(internal, "ensureCatalogRuntime").mockImplementation(async () => {
      if (!expertMajorPrepared) throw new Error("legacy branch checked before unified runtime selection");
    });

    await runtime.prepareCatalogRuntime(model);

    expect(pinRuntime).toHaveBeenCalledWith(model);
    expect(fullPolicy).toHaveBeenCalledWith(config, "ds4-expert-major-v1");
  });

  it("passes the GLM model identity into ExpertMajor catalog runtime preparation", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    const store = { get: vi.fn(() => structuredClone(config)) } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const model = {
      artifactFormat: "ds4-expert-major-v2",
      modelId: "glm-5.2"
    } as CatalogModel;
    const internal = runtime as unknown as {
      ensureCatalogRuntime(model: CatalogModel): Promise<void>;
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
    };
    const fullPolicy = vi.spyOn(internal, "ensureExpertMajorRuntimeCheckout").mockResolvedValue(config);
    vi.spyOn(internal, "ensureCatalogRuntime").mockResolvedValue();

    await runtime.prepareCatalogRuntime(model);

    expect(fullPolicy).toHaveBeenCalledWith(config, "ds4-expert-major-v2", false, "glm-5.2");
  });
});

describe("automatic memory watchdog", () => {
  function harness() {
    const runtime = new RuntimeManager({} as ConfigStore, new EventBus());
    const internal = runtime as unknown as {
      engine: (EventEmitter & { kill: ReturnType<typeof vi.fn> }) | null;
      stopping: boolean;
      automaticMemoryGuard: {
        baselineSwapoutPages: number;
        maxSwapoutDeltaPages: number;
        consecutiveReadFailures: number;
        triggered: boolean;
      } | null;
    };
    const installEngine = (exitOnSignal: "SIGTERM" | "SIGKILL") => {
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn((signal: NodeJS.Signals) => {
          if (signal === exitOnSignal) {
            internal.engine = null;
            child.emit("exit", null, signal);
          }
          return true;
        })
      });
      internal.engine = child;
      internal.stopping = false;
      return child;
    };
    const arm = (baselineSwapoutPages: number) => {
      internal.automaticMemoryGuard = {
        baselineSwapoutPages,
        maxSwapoutDeltaPages: 64,
        consecutiveReadFailures: 0,
        triggered: false
      };
    };
    return { runtime, internal, installEngine, arm };
  }

  it("stops on warning pressure or more than 64 new host-wide swapout pages", async () => {
    const { runtime, installEngine, arm } = harness();
    const swapChild = installEngine("SIGTERM");
    arm(1_000);

    await runtime.enforceAutomaticMemorySafety(1, 1_064);
    expect(swapChild.kill).not.toHaveBeenCalled();
    await runtime.enforceAutomaticMemorySafety(1, 1_065);
    expect(swapChild.kill).toHaveBeenCalledWith("SIGTERM");

    const pressureChild = installEngine("SIGTERM");
    arm(2_000);
    await runtime.enforceAutomaticMemorySafety(2, 2_000);
    expect(pressureChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails closed after three unreadable safety snapshots", async () => {
    const { runtime, installEngine, arm } = harness();
    const child = installEngine("SIGTERM");
    arm(1_000);

    await runtime.enforceAutomaticMemorySafety(null, null);
    await runtime.enforceAutomaticMemorySafety(null, null);
    expect(child.kill).not.toHaveBeenCalled();
    await runtime.enforceAutomaticMemorySafety(null, null);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates a stuck safety shutdown to SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, installEngine, arm } = harness();
      const child = installEngine("SIGKILL");
      arm(1_000);

      const stopping = runtime.enforceAutomaticMemorySafety(2, 1_000);
      await vi.advanceTimersByTimeAsync(3_001);
      await stopping;
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not race a voluntary stop", async () => {
    const { runtime, internal, installEngine, arm } = harness();
    const child = installEngine("SIGTERM");
    arm(1_000);
    internal.stopping = true;

    await runtime.enforceAutomaticMemorySafety(2, 1_000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
