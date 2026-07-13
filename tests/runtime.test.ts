import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../server/config.js";
import type { ConfigStore } from "../server/config.js";
import { EventBus } from "../server/event-bus.js";
import { shellDisplayArgument } from "../src/lib/arguments.js";
import {
  buildEngineArguments,
  orderedLocalModelScanRoots,
  parseEnvironment,
  parseFallbackModelFilename,
  parseVmStatSwapoutPages,
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
    const glm = createDefaultConfig(16 * 1024 ** 3);
    glm.model.id = "glm-5.2";
    glm.model.path = "/models/glm-5.2.gguf";
    expect(buildEngineArguments(glm)).not.toContain("--ssd-streaming-cache-experts");
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
