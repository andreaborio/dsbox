import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../server/config.js";
import {
  buildEngineArguments,
  parseEnvironment,
  parseFallbackModelFilename,
  remainingDownloadBytes,
  tokenizeArguments
} from "../server/runtime.js";

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
  it("builds the conservative 64 GB Metal and SSD profile", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    const args = buildEngineArguments(config);
    expect(args).toContain("--metal");
    expect(args).toContain("--ssd-streaming");
    expect(args).toContain("--ssd-streaming-cache-experts");
    expect(args).toContain("32GB");
    expect(args).toContain("--kv-disk-dir");
    expect(args).not.toContain("--chdir");
    expect(args).not.toContain("--cors");
    expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2)).toEqual(["--host", "127.0.0.1"]);
  });

  it("omits manual cache sizing in auto mode", () => {
    const config = createDefaultConfig(128 * 1024 ** 3);
    expect(config.streaming.cacheMode).toBe("auto");
    expect(buildEngineArguments(config)).not.toContain("--ssd-streaming-cache-experts");
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
