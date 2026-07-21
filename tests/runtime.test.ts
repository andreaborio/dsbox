import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../server/config.js";
import type { ConfigStore } from "../server/config.js";
import { EventBus } from "../server/event-bus.js";
import { shellDisplayArgument } from "../src/lib/arguments.js";
import type { CatalogModel, DsboxConfig, LocalModelCandidate } from "../src/types.js";
import {
  allowsLegacyCapabilityFallback,
  buildEngineArguments,
  ds4BuildInfoMatchesHead,
  engineBuildTargetFromMakefile,
  type EngineCapabilities,
  EXPERT_MAJOR_RUNTIME_BRANCH,
  EXPERT_MAJOR_RUNTIME_COMMIT,
  expertMajorLaunchEnvironment,
  gitRemoteIdentity,
  GLM52_RUNTIME_BRANCH,
  GLM52_RUNTIME_COMMIT,
  isSupportedEngineRemote,
  orderedLocalModelScanRoots,
  parseEngineCapabilitiesJson,
  parseEnvironment,
  parseFallbackModelFilename,
  parseVmStatSwapoutPages,
  probeEngineCapabilities,
  remainingDownloadBytes,
  resolveEngineBinaryPath,
  RuntimeManager,
  tokenizeArguments
} from "../server/runtime.js";
import { runtimeCompatibilityMatrix } from "./fixtures/hebrus-runtime-compatibility.js";

function engineCapabilities(engineId: "ds4" | "hebrus" = "ds4"): EngineCapabilities {
  return {
    schema_version: 1,
    engine_id: engineId,
    build_git_sha: "73a332fef82a",
    backend: "metal",
    executable_role: "server",
    model_families: ["deepseek4", "glm-dsa", "qwen35moe"],
    expert_major: {
      version: 2,
      tensor: "ds4.expert_major.v2",
      storage_formats: [
        { id: "ggml", wire_value: 0, group_sizes: [] },
        { id: "mlx-affine4", wire_value: 1, group_sizes: [64] }
      ]
    }
  };
}

describe("managed Git remote identity", () => {
  it("treats HTTPS and SSH URLs for the same GitHub repository as equivalent", () => {
    expect(gitRemoteIdentity("https://github.com/andreaborio/ds4.git"))
      .toBe(gitRemoteIdentity("git@github.com:andreaborio/ds4.git"));
    expect(gitRemoteIdentity("ssh://git@github.com/andreaborio/ds4"))
      .toBe("github.com/andreaborio/ds4");
  });

  it.each([
    "https://github.com/andreaborio/ds4.git",
    "git@github.com:andreaborio/ds4.git",
    "ssh://git@github.com/andreaborio/ds4",
    "https://github.com/andreaborio/hebrus.git",
    "git@github.com:andreaborio/hebrus.git",
    "ssh://git@github.com/andreaborio/hebrus"
  ])("accepts the bridged engine remote %s", (remote) => {
    expect(isSupportedEngineRemote(remote)).toBe(true);
  });

  it("does not accept a lookalike engine remote", () => {
    expect(isSupportedEngineRemote("https://github.com/example/hebrus.git")).toBe(false);
  });
});

describe("engine binary bridge", () => {
  it("prefers hebrus-server when both executable names exist", async () => {
    const checked: string[] = [];
    const binary = await resolveEngineBinaryPath("/runtime", async (candidate) => {
      checked.push(candidate);
      return true;
    });

    expect(binary).toBe("/runtime/hebrus-server");
    expect(checked).toEqual(["/runtime/hebrus-server"]);
  });

  it("falls back to ds4-server for existing installations", async () => {
    const checked: string[] = [];
    const binary = await resolveEngineBinaryPath("/runtime", async (candidate) => {
      checked.push(candidate);
      return candidate.endsWith("/ds4-server");
    });

    expect(binary).toBe("/runtime/ds4-server");
    expect(checked).toEqual(["/runtime/hebrus-server", "/runtime/ds4-server"]);
  });

  it("builds the Hebrus target only when the checkout declares it", () => {
    expect(engineBuildTargetFromMakefile("ds4-server: server.o\n")).toBe("ds4-server");
    expect(engineBuildTargetFromMakefile("ds4-server hebrus-server: server.o\n")).toBe("hebrus-server");
  });
});

describe("ExpertMajor engine capability bridge", () => {
  it.each(["ds4", "hebrus"] as const)("accepts the strict server contract for engine_id %s", async (engineId) => {
    const document = engineCapabilities(engineId);
    const run = vi.fn(async () => ({ stdout: `${JSON.stringify(document)}\n`, stderr: "" }));

    await expect(probeEngineCapabilities("/runtime/hebrus-server", "/runtime", run))
      .resolves.toEqual(document);
    expect(run).toHaveBeenCalledWith(
      "/runtime/hebrus-server",
      ["--capabilities=json"],
      expect.objectContaining({ cwd: "/runtime" })
    );
  });

  it("classifies only the legacy unknown-option response as unsupported", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("exit 2"), {
        stdout: "",
        stderr: "ds4-server: unknown option: --capabilities=json\n"
      });
    });

    await expect(probeEngineCapabilities("/runtime/ds4-server", "/runtime", run)).resolves.toBeNull();
  });

  it.each([
    ["malformed JSON", "{not-json", /malformed JSON/],
    ["an unknown schema", JSON.stringify({ ...engineCapabilities(), schema_version: 2 }), /Unsupported engine capability schema version/],
    [
      "a contradictory storage contract",
      JSON.stringify({
        ...engineCapabilities(),
        expert_major: {
          ...engineCapabilities().expert_major,
          storage_formats: [
            { id: "ggml", wire_value: 0, group_sizes: [] },
            { id: "mlx-affine4", wire_value: 1, group_sizes: [32] }
          ]
        }
      }),
      /storage wire contract/
    ]
  ])("fails closed when a supported capability command returns %s", async (_case, stdout, error) => {
    const run = vi.fn(async () => ({ stdout: String(stdout), stderr: "" }));

    await expect(probeEngineCapabilities("/runtime/hebrus-server", "/runtime", run)).rejects.toThrow(error as RegExp);
  });

  it("does not interpret a non-capability process failure as a legacy engine", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("terminated"), { stdout: "", stderr: "fatal runtime error" });
    });

    await expect(probeEngineCapabilities("/runtime/hebrus-server", "/runtime", run))
      .rejects.toThrow(/Unable to read engine capability contract/);
  });

  it("fails closed when a supported command emits diagnostics beside JSON", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify(engineCapabilities()),
      stderr: "warning: ambiguous build"
    }));

    await expect(probeEngineCapabilities("/runtime/hebrus-server", "/runtime", run))
      .rejects.toThrow(/unexpected diagnostic output/);
  });

  it("uses the source and binary-string probes only for a legacy capability-less engine", async () => {
    const runtime = new RuntimeManager({} as ConfigStore, new EventBus());
    const internal = runtime as unknown as {
      engineBinary(directory: string): Promise<string | null>;
      engineCapabilities(directory: string, binary: string): Promise<EngineCapabilities | null>;
      checkoutHasExpertMajorV2Source(directory: string): Promise<boolean>;
      legacyBinaryHasExpertMajorV2Runtime(binary: string): Promise<boolean>;
      binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
    };
    vi.spyOn(internal, "engineBinary").mockResolvedValue("/runtime/ds4-server");
    vi.spyOn(internal, "engineCapabilities").mockResolvedValue(null);
    const sourceProbe = vi.spyOn(internal, "checkoutHasExpertMajorV2Source").mockResolvedValue(true);
    const binaryProbe = vi.spyOn(internal, "legacyBinaryHasExpertMajorV2Runtime").mockResolvedValue(true);

    await expect(internal.binaryHasExpertMajorV2Runtime("/runtime")).resolves.toBe(true);
    expect(sourceProbe).toHaveBeenCalledWith("/runtime");
    expect(binaryProbe).toHaveBeenCalledWith("/runtime/ds4-server");
  });

  it("rejects a capability-less hebrus-server without invoking legacy probes", async () => {
    const runtime = new RuntimeManager({} as ConfigStore, new EventBus());
    const internal = runtime as unknown as {
      engineBinary(directory: string): Promise<string | null>;
      engineCapabilities(directory: string, binary: string): Promise<EngineCapabilities | null>;
      checkoutHasExpertMajorV2Source(directory: string): Promise<boolean>;
      legacyBinaryHasExpertMajorV2Runtime(binary: string): Promise<boolean>;
      binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
    };
    vi.spyOn(internal, "engineBinary").mockResolvedValue("/runtime/hebrus-server");
    vi.spyOn(internal, "engineCapabilities").mockResolvedValue(null);
    const sourceProbe = vi.spyOn(internal, "checkoutHasExpertMajorV2Source").mockResolvedValue(true);
    const binaryProbe = vi.spyOn(internal, "legacyBinaryHasExpertMajorV2Runtime").mockResolvedValue(true);

    await expect(internal.binaryHasExpertMajorV2Runtime("/runtime"))
      .rejects.toThrow(/hebrus-server does not expose the required structured capability contract/);
    expect(sourceProbe).not.toHaveBeenCalled();
    expect(binaryProbe).not.toHaveBeenCalled();
  });

  it("does not fall back when the supported capability command fails closed", async () => {
    const runtime = new RuntimeManager({} as ConfigStore, new EventBus());
    const internal = runtime as unknown as {
      engineBinary(directory: string): Promise<string | null>;
      engineCapabilities(directory: string, binary: string): Promise<EngineCapabilities | null>;
      checkoutHasExpertMajorV2Source(directory: string): Promise<boolean>;
      legacyBinaryHasExpertMajorV2Runtime(binary: string): Promise<boolean>;
      binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
    };
    vi.spyOn(internal, "engineBinary").mockResolvedValue("/runtime/hebrus-server");
    vi.spyOn(internal, "engineCapabilities").mockRejectedValue(new Error("Engine capability command returned malformed JSON"));
    const sourceProbe = vi.spyOn(internal, "checkoutHasExpertMajorV2Source").mockResolvedValue(true);
    const binaryProbe = vi.spyOn(internal, "legacyBinaryHasExpertMajorV2Runtime").mockResolvedValue(true);

    await expect(internal.binaryHasExpertMajorV2Runtime("/runtime")).rejects.toThrow(/malformed JSON/);
    expect(sourceProbe).not.toHaveBeenCalled();
    expect(binaryProbe).not.toHaveBeenCalled();
  });

  it("rejects contradictory server identity before runtime admission", () => {
    expect(() => parseEngineCapabilitiesJson(JSON.stringify({
      ...engineCapabilities(),
      executable_role: "cli"
    }))).toThrow(/server executable/);
  });
});

describe("DS4 to Hebrus cross-version compatibility matrix", () => {
  it.each(runtimeCompatibilityMatrix)("classifies $name", async ({ remote, binaryName, capability, expected }) => {
    const binary = await resolveEngineBinaryPath("/runtime", async (candidate) => candidate.endsWith(`/${binaryName}`));
    expect(binary).toBe(`/runtime/${binaryName}`);
    expect(isSupportedEngineRemote(remote)).toBe(true);

    const admission = async (): Promise<"legacy" | "structured"> => {
      const result = await probeEngineCapabilities(binary!, "/runtime", async () => {
        if (!capability) {
          throw Object.assign(new Error("exit 2"), {
            stdout: "",
            stderr: `${binaryName}: unknown option: --capabilities=json\n`
          });
        }
        return { stdout: `${JSON.stringify(capability)}\n`, stderr: "" };
      });
      if (result) return "structured";
      if (allowsLegacyCapabilityFallback(binary!)) return "legacy";
      throw new Error("hebrus-server does not expose the required structured capability contract");
    };

    if (expected === "reject") await expect(admission()).rejects.toThrow();
    else await expect(admission()).resolves.toBe(expected);
  });
});

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

  it("removes retired ExpertMajor tuning from managed launch environments", () => {
    expect(expertMajorLaunchEnvironment(
      { DS4_EXPERT_PROFILE: "old", KEEP_ME: "yes" },
      { DS4_QWEN_EXPERIMENTAL_METAL: "1", DS4_METAL_MEMORY_REPORT: "1" }
    )).toEqual({
      KEEP_ME: "yes",
      DS4_METAL_MEMORY_REPORT: "1"
    });
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
  it("uses the bounded 16 GB profile for an unmanaged runtime", () => {
    const config = createDefaultConfig(16 * 1024 ** 3);
    config.model.id = "custom-moe";
    const args = buildEngineArguments(config);
    expect(args.slice(args.indexOf("--ctx"), args.indexOf("--ctx") + 2)).toEqual(["--ctx", "8192"]);
    expect(args.slice(args.indexOf("--tokens"), args.indexOf("--tokens") + 2)).toEqual(["--tokens", "4096"]);
    expect(args).toContain("--ssd-streaming");
    expect(args).not.toContain("--ssd-streaming-cache-experts");
    expect(args.slice(args.indexOf("--power"), args.indexOf("--power") + 2)).toEqual(["--power", "100"]);
  });

  it("uses DS4 adaptive cache sizing for an unmanaged 64 GB runtime", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.model.id = "custom-moe";
    const args = buildEngineArguments(config);
    expect(args).toContain("--metal");
    expect(args).toContain("--ssd-streaming");
    expect(args).not.toContain("--ssd-streaming-cache-experts");
    expect(args).toContain("--kv-disk-dir");
    expect(args).not.toContain("--chdir");
    expect(args).not.toContain("--cors");
    expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2)).toEqual(["--host", "127.0.0.1"]);
  });

  const managedModels = [
    { modelId: "qwen3.6-35b-a3b", architecture: "qwen35moe", path: "/models/qwen-v2.gguf", supportsDiskKv: false, supportsImatrixSteering: false, supportsPrefillOverride: false },
    { modelId: "deepseek-v4-flash", architecture: "deepseek4", path: "/models/deepseek-v2.gguf", supportsDiskKv: true, supportsImatrixSteering: true, supportsPrefillOverride: true },
    { modelId: "glm-5.2", architecture: "glm-dsa", path: "/models/glm-v2.gguf", supportsDiskKv: true, supportsImatrixSteering: false, supportsPrefillOverride: false }
  ] as const;

  it.each(managedModels)("delegates $modelId ExpertMajor v2 startup to DS4 AUTO", ({ modelId, architecture, path, supportsDiskKv, supportsImatrixSteering, supportsPrefillOverride }) => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.model = { id: modelId, path };
    config.server.powerPercent = 48;
    config.server.quality = true;
    config.server.warmWeights = true;
    config.server.prefillChunk = 2048;
    config.streaming.cacheMode = "manual";
    config.streaming.cacheSizeGb = 24;
    config.streaming.coldStart = true;
    config.streaming.preloadExperts = 512;
    config.observability.imatrixEnabled = true;
    config.advanced.extraArgs = [
      "--metal",
      "--debug",
      "--backend metal",
      "--power 12",
      "--quality",
      "--warm-weights",
      "--resident",
      "--no-ssd-streaming",
      "--ssd-streaming",
      "--ssd-streaming-cold",
      "--ssd-streaming-cache-experts 700",
      "--ssd-streaming-preload-experts 200",
      "--prefill-chunk 1024",
      "--mtp /models/draft.gguf",
      "--role coordinator",
      "--listen 127.0.0.1 9000",
      "--dist-prefill-chunk 64",
      "--dir-steering-file /tmp/steer.bin",
      "--kv-disk-dir /tmp/custom-kv",
      "--imatrix-out /tmp/custom-imatrix.dat",
      "--trace /tmp/managed.trace"
    ].join(" ");

    const args = buildEngineArguments(config, architecture);
    expect(args).toEqual(expect.arrayContaining([
      "-m", path,
      "--ctx", String(config.server.contextTokens),
      "--tokens", String(config.server.maxOutputTokens),
      "--threads", String(config.server.threads),
      "--host", "127.0.0.1",
      "--port", String(config.server.internalPort),
      "--trace", "/tmp/managed.trace"
    ]));
    for (const retired of [
      "--metal",
      "--debug",
      "--backend",
      "--power",
      "--quality",
      "--warm-weights",
      "--resident",
      "--no-ssd-streaming",
      "--ssd-streaming",
      "--ssd-streaming-cold",
      "--ssd-streaming-cache-experts",
      "--ssd-streaming-preload-experts",
      "--mtp",
      "--role",
      "--listen",
      "--dist-prefill-chunk"
    ]) {
      expect(args, `${modelId} leaked ${retired}`).not.toContain(retired);
    }
    if (supportsDiskKv) {
      expect(args).toContain("--kv-disk-dir");
      expect(args).toContain("/tmp/custom-kv");
    } else {
      expect(args).not.toContain("--kv-disk-dir");
      expect(args).not.toContain("/tmp/custom-kv");
    }
    if (supportsImatrixSteering) {
      expect(args).toContain("--imatrix-out");
      expect(args).toContain("/tmp/custom-imatrix.dat");
      expect(args).toContain("--dir-steering-file");
      expect(args).toContain("/tmp/steer.bin");
    } else {
      expect(args).not.toContain("--imatrix-out");
      expect(args).not.toContain("/tmp/custom-imatrix.dat");
      expect(args).not.toContain("--dir-steering-file");
      expect(args).not.toContain("/tmp/steer.bin");
    }
    if (supportsPrefillOverride) {
      expect(args).toContain("--prefill-chunk");
      expect(args).toContain("1024");
    } else {
      expect(args).not.toContain("--prefill-chunk");
      expect(args).not.toContain("1024");
      expect(args).not.toContain("2048");
    }
  });

  it("preserves manual GB and advanced exact overrides without duplicates", () => {
    const manual = createDefaultConfig(64 * 1024 ** 3);
    manual.model.id = "custom-moe";
    manual.streaming.cacheMode = "manual";
    manual.streaming.cacheSizeGb = 32;
    expect(buildEngineArguments(manual)).toContain("32GB");

    const advanced = createDefaultConfig(16 * 1024 ** 3);
    advanced.model.id = "custom-moe";
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
    config.model.id = "custom-moe";
    config.observability.traceEnabled = true;
    config.observability.imatrixEnabled = true;
    const args = buildEngineArguments(config);
    expect(args).toContain("--trace");
    expect(args).toContain("--imatrix-out");
    expect(args).toContain("--imatrix-every");
  });

  it("uses verified architecture instead of a misleading configured model id", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.model.id = "qwen3.6-35b-a3b";
    config.server.quality = true;

    expect(buildEngineArguments(config, "custom-moe")).toContain("--quality");
    config.model.id = "custom-moe";
    expect(buildEngineArguments(config, "qwen35moe")).not.toContain("--quality");
  });

  it("keeps managed identity, context, output, threads, and loopback binding authoritative", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.model = { path: "/models/release.gguf", id: "deepseek-v4-flash" };
    config.server.contextTokens = 32_768;
    config.server.maxOutputTokens = 512;
    config.server.threads = 8;
    config.server.internalHost = "127.0.0.1";
    config.server.internalPort = 5678;
    config.advanced.extraArgs = [
      "-m /tmp/evil.gguf",
      "--model=/tmp/also-evil.gguf",
      "-c 1",
      "--ctx=2",
      "-n 3",
      "--tokens=4",
      "-t 1",
      "--threads=2",
      "--host 0.0.0.0",
      "--port=9999",
      "--chdir /tmp",
      "--cors"
    ].join(" ");

    const args = buildEngineArguments(config, "deepseek4");

    expect(args).toEqual(expect.arrayContaining([
      "-m", "/models/release.gguf",
      "--ctx", "32768",
      "--tokens", "512",
      "--threads", "8",
      "--host", "127.0.0.1",
      "--port", "5678"
    ]));
    expect(args.join(" ")).not.toMatch(/evil|0\.0\.0\.0|9999|--chdir|--cors/);
    expect(args.filter((value) => value === "-m" || value === "--model")).toHaveLength(1);
    expect(args.filter((value) => value === "--ctx" || value === "-c")).toHaveLength(1);
  });
});

describe("ExpertMajor v2 one-click preparation", () => {
  it("fails local ExpertMajor startup below the 64 GiB release floor", async () => {
    const config = createDefaultConfig(32 * 1024 ** 3);
    const store = { get: vi.fn(() => structuredClone(config)) } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus(), 32 * 1024 ** 3);
    const internal = runtime as unknown as { startEngine(): Promise<void> };

    await expect(internal.startEngine()).rejects.toThrow("requires at least 64 GiB");
  });

  it("uses the Qwen-specific 16 GiB AUTO floor", async () => {
    const config = createDefaultConfig(8 * 1024 ** 3);
    config.model.id = "qwen3.6-35b-a3b";
    const store = { get: vi.fn(() => structuredClone(config)) } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus(), 8 * 1024 ** 3);
    const internal = runtime as unknown as { startEngine(): Promise<void> };

    await expect(internal.startEngine()).rejects.toThrow("requires at least 16 GiB");
  });

  it("shows a plain Qwen startup command without an environment gate prefix", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.model = {
      path: "/models/Qwen3.6-35B-A3B-DS4-ExpertMajor-v2-MLX-Affine4-G64.gguf",
      id: "qwen3.6-35b-a3b"
    };
    const store = { get: vi.fn(() => structuredClone(config)) } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const internal = runtime as unknown as {
      inspectLocalModel(modelPath: string, selectedPath: string): Promise<LocalModelCandidate | null>;
    };
    vi.spyOn(internal, "inspectLocalModel").mockResolvedValue({
      path: config.model.path,
      name: "Qwen3.6 ExpertMajor v2",
      sizeBytes: 20_808_566_880,
      modelId: config.model.id,
      selected: true,
      compatibility: { status: "compatible", code: "ds4_native", reason: null },
      architecture: "qwen35moe",
      artifactFormat: "ds4-expert-major-v2"
    });

    const command = await runtime.commandPreview();

    expect(command[0]).toBe(`${config.repository.directory}/ds4-server`);
    expect(command.join(" ")).not.toContain("DS4_QWEN_EXPERIMENTAL_METAL");
  });

  it("replaces an older Qwen checkout with the unified ExpertMajor v2 runtime", async () => {
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
      checkoutHasExpertMajorV2Source(directory: string): Promise<boolean>;
      binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
      managedCheckoutIdentity(directory: string): Promise<{ exists: boolean; branch: string | null; remote: string | null; clean: boolean }>;
      runtimeIncludesCommit(directory: string, commit: string): Promise<boolean>;
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
    };
    const managedDirectory = "/home/alice/.dsbox/runtime/andreaborio-ds4";
    vi.spyOn(internal, "managedCheckoutIdentity").mockResolvedValue({
      exists: true,
      branch: "main",
      remote: "https://github.com/andreaborio/ds4.git",
      clean: true
    });
    vi.spyOn(internal, "checkoutHasExpertMajorV2Source").mockImplementation(async (directory) => directory === managedDirectory);
    vi.spyOn(internal, "runtimeIncludesCommit").mockImplementation(async (directory, commit) =>
      directory === managedDirectory && commit === EXPERT_MAJOR_RUNTIME_COMMIT);
    vi.spyOn(internal, "binaryHasExpertMajorV2Runtime").mockResolvedValue(true);
    vi.spyOn(internal, "binaryMatchesCheckoutHead").mockResolvedValue(true);
    vi.spyOn(runtime, "refresh").mockResolvedValue(runtime.getState());

    const selected = await internal.ensureExpertMajorRuntimeCheckout(
      config,
      "ds4-expert-major-v2",
      false,
      "qwen35moe"
    );

    expect(EXPERT_MAJOR_RUNTIME_COMMIT).toBe("57acfd408a3154851a0c59be432904300abb3b6c");
    expect(selected.repository).toMatchObject({
      url: "https://github.com/andreaborio/ds4.git",
      directory: managedDirectory,
      branch: EXPERT_MAJOR_RUNTIME_BRANCH
    });
    expect(store.set).toHaveBeenCalledOnce();
  });

  it("selects the unified v2 checkout before considering a default runtime install", async () => {
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
      architecture: "qwen35moe",
      artifactFormat: "ds4-expert-major-v2"
    };
    vi.spyOn(runtime, "refresh").mockResolvedValueOnce(initial).mockResolvedValue(ready);
    vi.spyOn(runtime, "validateLocalModel").mockResolvedValue(candidate);
    const internal = runtime as unknown as {
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
    };
    const prepareV2 = vi.spyOn(internal, "ensureExpertMajorRuntimeCheckout").mockResolvedValue(config);
    const install = vi.spyOn(runtime, "installOrUpdate").mockResolvedValue();
    const build = vi.spyOn(runtime, "build").mockResolvedValue();
    const start = vi.spyOn(runtime, "start").mockResolvedValue();

    await runtime.oneClickStart();

    expect(prepareV2).toHaveBeenCalledWith(config, "ds4-expert-major-v2", false, "qwen35moe");
    expect(install).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });

  it("moves Qwen ExpertMajor v2 off a legacy branch and requires unified main ancestry", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.repository.branch = "codex/qwen-tool-dialect";
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
    const ancestryChecks: string[] = [];
    const internal = runtime as unknown as {
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
      checkoutHasExpertMajorV2Source(directory: string): Promise<boolean>;
      runtimeIncludesCommit(directory: string, commit: string): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
      binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
      managedCheckoutIdentity(directory: string): Promise<{ exists: boolean; branch: string | null; remote: string | null; clean: boolean }>;
    };
    vi.spyOn(internal, "managedCheckoutIdentity")
      .mockResolvedValueOnce({
        exists: true,
        branch: "codex/qwen-tool-dialect",
        remote: "git@github.com:andreaborio/ds4.git",
        clean: true
      })
      .mockResolvedValue({
        exists: true,
        branch: "main",
        remote: "git@github.com:andreaborio/ds4.git",
        clean: true
      });
    vi.spyOn(internal, "checkoutHasExpertMajorV2Source")
      .mockImplementation(async (directory) => directory === "/home/alice/.dsbox/runtime/andreaborio-ds4");
    vi.spyOn(internal, "runtimeIncludesCommit").mockImplementation(async (directory, commit) => {
      ancestryChecks.push(commit);
      return directory === "/home/alice/.dsbox/runtime/andreaborio-ds4";
    });
    vi.spyOn(internal, "binaryMatchesCheckoutHead").mockResolvedValue(true);
    vi.spyOn(internal, "binaryHasExpertMajorV2Runtime").mockResolvedValue(true);
    vi.spyOn(runtime, "refresh").mockResolvedValue(runtime.getState());
    const install = vi.spyOn(runtime, "installOrUpdate").mockResolvedValue();
    const build = vi.spyOn(runtime, "build").mockResolvedValue();

    const selected = await internal.ensureExpertMajorRuntimeCheckout(
      config,
      "ds4-expert-major-v2",
      true,
      "qwen35moe"
    );

    expect(selected.repository).toMatchObject({
      url: "https://github.com/andreaborio/ds4.git",
      branch: "main",
      directory: "/home/alice/.dsbox/runtime/andreaborio-ds4"
    });
    expect(ancestryChecks).not.toHaveLength(0);
    expect(ancestryChecks.every((commit) => commit === EXPERT_MAJOR_RUNTIME_COMMIT)).toBe(true);
    expect(install).toHaveBeenCalledWith(true);
    expect(build).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a dirty non-main checkout",
      identity: { exists: true, branch: "experiment", remote: "https://github.com/andreaborio/ds4.git", clean: false },
      error: "has local changes"
    },
    {
      name: "a checkout from another origin",
      identity: { exists: true, branch: "main", remote: "https://github.com/example/ds4.git", clean: true },
      error: "different origin remote"
    }
  ])("rejects $name instead of presenting it as unified main", async ({ identity, error }) => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.repository.directory = "/home/alice/.dsbox/runtime/andreaborio-ds4";
    const store = {
      homeDirectory: "/home/alice/.dsbox",
      get: vi.fn(() => structuredClone(config))
    } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const internal = runtime as unknown as {
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
      managedCheckoutIdentity(directory: string): Promise<{ exists: boolean; branch: string | null; remote: string | null; clean: boolean }>;
    };
    vi.spyOn(internal, "managedCheckoutIdentity").mockResolvedValue(identity);
    const install = vi.spyOn(runtime, "installOrUpdate").mockResolvedValue();

    await expect(internal.ensureExpertMajorRuntimeCheckout(
      config,
      "ds4-expert-major-v2",
      false,
      "deepseek4"
    )).rejects.toThrow(error);
    expect(install).not.toHaveBeenCalled();
  });

  it("qualifies GLM ExpertMajor v2 from the unified main checkout and current-binary capabilities", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.repository = {
      url: "https://github.com/andreaborio/ds4.git",
      branch: "main",
      directory: "/home/alice/.dsbox/runtime/andreaborio-ds4"
    };
    const store = {
      homeDirectory: "/home/alice/.dsbox",
      get: vi.fn(() => structuredClone(config))
    } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const internal = runtime as unknown as {
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
      checkoutHasExpertMajorV2Source(directory: string): Promise<boolean>;
      binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
      managedCheckoutIdentity(directory: string): Promise<{ exists: boolean; branch: string | null; remote: string | null; clean: boolean }>;
      runtimeIncludesCommit(directory: string, commit: string): Promise<boolean>;
    };
    vi.spyOn(internal, "managedCheckoutIdentity").mockResolvedValue({
      exists: true,
      branch: "main",
      remote: "https://github.com/andreaborio/ds4.git",
      clean: true
    });
    const sourceCapability = vi.spyOn(internal, "checkoutHasExpertMajorV2Source").mockResolvedValue(true);
    const binaryCapability = vi.spyOn(internal, "binaryHasExpertMajorV2Runtime").mockResolvedValue(true);
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
    expect(sourceCapability).not.toHaveBeenCalled();
    expect(binaryCapability).toHaveBeenCalledWith(config.repository.directory);
    expect(pinnedAncestry).toHaveBeenCalledWith(config.repository.directory, GLM52_RUNTIME_COMMIT);
    expect(install).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("keeps a qualified Hebrus managed checkout without rewriting it to the legacy Git identity", async () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    config.repository = {
      url: "https://github.com/andreaborio/hebrus.git",
      branch: "main",
      directory: "/home/alice/.dsbox/runtime/andreaborio-hebrus"
    };
    const store = {
      homeDirectory: "/home/alice/.dsbox",
      get: vi.fn(() => structuredClone(config)),
      set: vi.fn()
    } as unknown as ConfigStore;
    const runtime = new RuntimeManager(store, new EventBus());
    const internal = runtime as unknown as {
      ensureExpertMajorRuntimeCheckout(
        config: DsboxConfig,
        format: "ds4-expert-major-v2",
        allowModelSwitch: boolean,
        modelIdentity: string
      ): Promise<DsboxConfig>;
      binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
      managedCheckoutIdentity(directory: string): Promise<{ exists: boolean; branch: string | null; remote: string | null; clean: boolean }>;
      runtimeIncludesCommit(directory: string, commit: string): Promise<boolean>;
    };
    vi.spyOn(internal, "managedCheckoutIdentity").mockResolvedValue({
      exists: true,
      branch: "main",
      remote: "git@github.com:andreaborio/hebrus.git",
      clean: true
    });
    vi.spyOn(internal, "runtimeIncludesCommit").mockResolvedValue(true);
    vi.spyOn(internal, "binaryMatchesCheckoutHead").mockResolvedValue(true);
    vi.spyOn(internal, "binaryHasExpertMajorV2Runtime").mockResolvedValue(true);
    const install = vi.spyOn(runtime, "installOrUpdate").mockResolvedValue();
    const build = vi.spyOn(runtime, "build").mockResolvedValue();

    const selected = await internal.ensureExpertMajorRuntimeCheckout(
      config,
      "ds4-expert-major-v2",
      false,
      "deepseek4"
    );

    expect(selected.repository).toEqual(config.repository);
    expect(store.set).not.toHaveBeenCalled();
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
      checkoutHasExpertMajorV2Source(directory: string): Promise<boolean>;
      runtimeIncludesCommit(directory: string, commit: string): Promise<boolean>;
      binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
      binaryMatchesCheckoutHead(directory: string): Promise<boolean>;
      managedCheckoutIdentity(directory: string): Promise<{ exists: boolean; branch: string | null; remote: string | null; clean: boolean }>;
    };
    let installed = false;
    vi.spyOn(internal, "managedCheckoutIdentity").mockImplementation(async () => installed
      ? { exists: true, branch: "main", remote: "https://github.com/andreaborio/ds4.git", clean: true }
      : { exists: false, branch: null, remote: null, clean: true });
    vi.spyOn(internal, "checkoutHasExpertMajorV2Source")
      .mockImplementation(async (directory) => installed && directory === targetDirectory);
    vi.spyOn(internal, "runtimeIncludesCommit")
      .mockImplementation(async (directory, commit) => installed && directory === targetDirectory && commit === GLM52_RUNTIME_COMMIT);
    vi.spyOn(internal, "binaryHasExpertMajorV2Runtime").mockResolvedValue(true);
    vi.spyOn(internal, "binaryMatchesCheckoutHead").mockResolvedValue(true);
    vi.spyOn(runtime, "refresh").mockResolvedValue(runtime.getState());
    const install = vi.spyOn(runtime, "installOrUpdate").mockImplementation(async () => {
      installed = true;
    });

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
    const model = {
      artifactFormat: "ds4-expert-major-v2",
      modelId: "qwen3.6-35b-a3b"
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
    expect(fullPolicy).toHaveBeenCalledWith(config, "ds4-expert-major-v2", false, "qwen3.6-35b-a3b");
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
