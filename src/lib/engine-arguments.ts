import type { DsboxConfig } from "../types.js";
import { argumentOptionName, tokenizeArguments } from "./arguments.js";

export const QWEN35_MODEL_ID = "qwen3.6-35b-a3b";
export const QWEN35_ARCHITECTURE = "qwen35moe";

export function isQwen35Model(config: Pick<DsboxConfig, "model">, modelArchitecture?: string | null): boolean {
  return modelArchitecture === undefined
    ? config.model.id.trim().toLowerCase() === QWEN35_MODEL_ID
    : modelArchitecture?.trim().toLowerCase() === QWEN35_ARCHITECTURE;
}

const qwenManagedBooleanOptions = new Set([
  "--quality",
  "--warm-weights",
  "--resident",
  "--no-ssd-streaming",
  "--cpu",
  "--cuda",
  "--rocm",
  "--dist-replay-check",
  "--kv-cache-reject-different-quant"
]);

const qwenManagedSingleValueOptions = new Set([
  "--power",
  "--backend",
  "--ssd-streaming-cache-experts",
  "--ssd-streaming-preload-experts",
  "--imatrix-out",
  "--imatrix-every",
  "--imatrix-min-requests",
  "--mtp",
  "--mtp-draft",
  "--mtp-margin",
  "--role",
  "--layers",
  "--dist-prefill-chunk",
  "--dist-prefill-window",
  "--dist-activation-bits",
  "--dir-steering-file",
  "--dir-steering-ffn",
  "--dir-steering-attn",
  "--expert-profile",
  "--kv-disk-dir",
  "--kv-disk-space-mb",
  "--kv-cache-min-tokens",
  "--kv-cache-cold-max-tokens",
  "--kv-cache-continued-interval-tokens",
  "--kv-cache-boundary-trim-tokens",
  "--kv-cache-boundary-align-tokens"
]);

const qwenManagedDoubleValueOptions = new Set(["--listen", "--coordinator"]);

function qwenSafeExtraArguments(extraArgs: string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const value = extraArgs[index];
    const option = argumentOptionName(value);
    if (qwenManagedBooleanOptions.has(option)) continue;
    if (qwenManagedSingleValueOptions.has(option)) {
      if (value === option) index += 1;
      continue;
    }
    if (qwenManagedDoubleValueOptions.has(option)) {
      if (value === option) index += 2;
      continue;
    }
    safe.push(value);
  }
  return safe;
}

export function buildEngineArguments(config: DsboxConfig, modelArchitecture?: string | null): string[] {
  const qwen35 = isQwen35Model(config, modelArchitecture);
  const tokenizedExtraArgs = tokenizeArguments(config.advanced.extraArgs);
  const extraArgs = qwen35 ? qwenSafeExtraArguments(tokenizedExtraArgs) : tokenizedExtraArgs;
  const advancedCacheOverride = extraArgs.some(
    (value) => argumentOptionName(value) === "--ssd-streaming-cache-experts"
  );
  const args = [
    "--metal",
    "-m", config.model.path,
    "--ctx", String(config.server.contextTokens),
    "--tokens", String(config.server.maxOutputTokens),
    "--threads", String(config.server.threads),
    "--power", String(qwen35 ? 100 : config.server.powerPercent),
    "--host", config.server.internalHost,
    "--port", String(config.server.internalPort)
  ];

  if (config.streaming.enabled) {
    args.push("--ssd-streaming");
    if (!qwen35 && !advancedCacheOverride && config.streaming.cacheMode === "manual") {
      args.push("--ssd-streaming-cache-experts", `${config.streaming.cacheSizeGb}GB`);
    }
    if (config.streaming.coldStart) args.push("--ssd-streaming-cold");
    if (!qwen35 && config.streaming.preloadExperts !== null) {
      args.push("--ssd-streaming-preload-experts", String(config.streaming.preloadExperts));
    }
  }

  if (config.server.prefillChunk !== null) {
    args.push("--prefill-chunk", String(config.server.prefillChunk));
  }
  if (!qwen35 && config.server.quality) args.push("--quality");
  if (!qwen35 && config.server.warmWeights) args.push("--warm-weights");

  // The current Qwen runtime keeps the live in-memory context, but its
  // model-specific session payload cannot be serialized yet. Passing the disk
  // KV flags would advertise a cache that every Qwen save/load must reject.
  if (!qwen35 && config.kvCache.enabled) {
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
  if (!qwen35 && config.observability.imatrixEnabled) {
    args.push(
      "--imatrix-out", config.observability.imatrixPath,
      "--imatrix-every", String(config.observability.imatrixEvery)
    );
  }

  args.push(...extraArgs);
  return args;
}
