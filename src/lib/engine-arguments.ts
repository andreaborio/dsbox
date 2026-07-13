import type { DsboxConfig } from "../types.js";
import { argumentOptionName, tokenizeArguments } from "./arguments.js";

export function buildEngineArguments(config: DsboxConfig): string[] {
  const extraArgs = tokenizeArguments(config.advanced.extraArgs);
  const advancedCacheOverride = extraArgs.some(
    (value) => argumentOptionName(value) === "--ssd-streaming-cache-experts"
  );
  const args = [
    "--metal",
    "-m", config.model.path,
    "--ctx", String(config.server.contextTokens),
    "--tokens", String(config.server.maxOutputTokens),
    "--threads", String(config.server.threads),
    "--power", String(config.server.powerPercent),
    "--host", config.server.internalHost,
    "--port", String(config.server.internalPort)
  ];

  if (config.streaming.enabled) {
    args.push("--ssd-streaming");
    if (!advancedCacheOverride && config.streaming.cacheMode === "manual") {
      args.push("--ssd-streaming-cache-experts", `${config.streaming.cacheSizeGb}GB`);
    }
    if (config.streaming.coldStart) args.push("--ssd-streaming-cold");
    if (config.streaming.preloadExperts !== null) {
      args.push("--ssd-streaming-preload-experts", String(config.streaming.preloadExperts));
    }
  }

  if (config.server.prefillChunk !== null) {
    args.push("--prefill-chunk", String(config.server.prefillChunk));
  }
  if (config.server.quality) args.push("--quality");
  if (config.server.warmWeights) args.push("--warm-weights");

  if (config.kvCache.enabled) {
    args.push(
      "--kv-disk-dir", config.kvCache.directory,
      "--kv-disk-space-mb", String(config.kvCache.spaceMb),
      "--kv-cache-min-tokens", String(config.kvCache.minTokens),
      "--kv-cache-continued-interval-tokens", String(config.kvCache.continuedIntervalTokens)
    );
  }

  if (config.observability.traceEnabled) {
    args.push("--trace", config.observability.tracePath);
  }
  if (config.observability.imatrixEnabled) {
    args.push(
      "--imatrix-out", config.observability.imatrixPath,
      "--imatrix-every", String(config.observability.imatrixEvery)
    );
  }

  args.push(...extraArgs);
  return args;
}
