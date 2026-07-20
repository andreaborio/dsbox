import type { DsboxConfig } from "../types.js";
import { argumentOptionName, tokenizeArguments } from "./arguments.js";

export const QWEN35_MODEL_ID = "qwen3.6-35b-a3b";
export const QWEN35_ARCHITECTURE = "qwen35moe";
export const DEEPSEEK4_MODEL_ID = "deepseek-v4-flash";
export const DEEPSEEK4_ARCHITECTURE = "deepseek4";
export const GLM52_MODEL_ID = "glm-5.2";
export const GLM52_ARCHITECTURE = "glm-dsa";

const managedExpertMajorV2ModelIds = new Set([
  QWEN35_MODEL_ID,
  DEEPSEEK4_MODEL_ID,
  GLM52_MODEL_ID
]);

const managedExpertMajorV2Architectures = new Set([
  QWEN35_ARCHITECTURE,
  DEEPSEEK4_ARCHITECTURE,
  GLM52_ARCHITECTURE
]);

export function isQwen35Model(config: Pick<DsboxConfig, "model">, modelArchitecture?: string | null): boolean {
  return modelArchitecture === undefined
    ? config.model.id.trim().toLowerCase() === QWEN35_MODEL_ID
    : modelArchitecture?.trim().toLowerCase() === QWEN35_ARCHITECTURE;
}

export function isGlm52Model(config: Pick<DsboxConfig, "model">, modelArchitecture?: string | null): boolean {
  return modelArchitecture === undefined
    ? config.model.id.trim().toLowerCase() === GLM52_MODEL_ID
    : modelArchitecture?.trim().toLowerCase() === GLM52_ARCHITECTURE;
}

export function isManagedExpertMajorV2Model(
  config: Pick<DsboxConfig, "model">,
  modelArchitecture?: string | null
): boolean {
  return modelArchitecture === undefined
    ? managedExpertMajorV2ModelIds.has(config.model.id.trim().toLowerCase())
    : managedExpertMajorV2Architectures.has(modelArchitecture?.trim().toLowerCase() ?? "");
}

const managedExpertMajorV2BooleanOptions = new Set([
  "--quality",
  "--warm-weights",
  "--ssd-streaming",
  "--ssd-streaming-cold",
  "--resident",
  "--no-ssd-streaming",
  "--metal",
  "--cpu",
  "--cuda",
  "--rocm",
  "--debug",
  "--dist-replay-check"
]);

const managedExpertMajorV2SingleValueOptions = new Set([
  "--power",
  "--backend",
  "--ssd-streaming-cache-experts",
  "--ssd-streaming-preload-experts",
  "--mtp",
  "--mtp-draft",
  "--mtp-margin",
  "--role",
  "--layers",
  "--dist-prefill-chunk",
  "--dist-prefill-window",
  "--dist-activation-bits",
  "--expert-profile"
]);

const qwenUnsupportedBooleanOptions = new Set([
  "--kv-cache-reject-different-quant"
]);

const deepSeekOnlyManagedSingleValueOptions = new Set([
  "--imatrix-out",
  "--imatrix-every",
  "--imatrix-min-requests",
  "--dir-steering-file",
  "--dir-steering-ffn",
  "--dir-steering-attn",
  "--prefill-chunk"
]);

const qwenUnsupportedSingleValueOptions = new Set([
  "--kv-disk-dir",
  "--kv-disk-space-mb",
  "--kv-cache-min-tokens",
  "--kv-cache-cold-max-tokens",
  "--kv-cache-continued-interval-tokens",
  "--kv-cache-boundary-trim-tokens",
  "--kv-cache-boundary-align-tokens"
]);

const managedExpertMajorV2DoubleValueOptions = new Set(["--listen", "--coordinator"]);

function managedExpertMajorV2ExtraArguments(extraArgs: string[], qwen35: boolean, glm52: boolean): string[] {
  const safe: string[] = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const value = extraArgs[index];
    const option = argumentOptionName(value);
    if (managedExpertMajorV2BooleanOptions.has(option)
      || (qwen35 && qwenUnsupportedBooleanOptions.has(option))) continue;
    if (managedExpertMajorV2SingleValueOptions.has(option)
      || ((qwen35 || glm52) && deepSeekOnlyManagedSingleValueOptions.has(option))
      || (qwen35 && qwenUnsupportedSingleValueOptions.has(option))) {
      if (value === option) index += 1;
      continue;
    }
    if (managedExpertMajorV2DoubleValueOptions.has(option)) {
      if (value === option) index += 2;
      continue;
    }
    safe.push(value);
  }
  return safe;
}

export function buildEngineArguments(config: DsboxConfig, modelArchitecture?: string | null): string[] {
  const managedExpertMajorV2 = isManagedExpertMajorV2Model(config, modelArchitecture);
  const qwen35 = isQwen35Model(config, modelArchitecture);
  const glm52 = isGlm52Model(config, modelArchitecture);
  const tokenizedExtraArgs = tokenizeArguments(config.advanced.extraArgs);
  const extraArgs = managedExpertMajorV2
    ? managedExpertMajorV2ExtraArguments(tokenizedExtraArgs, qwen35, glm52)
    : tokenizedExtraArgs;
  const advancedCacheOverride = extraArgs.some(
    (value) => argumentOptionName(value) === "--ssd-streaming-cache-experts"
  );
  const advancedPrefillOverride = extraArgs.some(
    (value) => argumentOptionName(value) === "--prefill-chunk"
  );
  const args = [
    "-m", config.model.path,
    "--ctx", String(config.server.contextTokens),
    "--tokens", String(config.server.maxOutputTokens),
    "--threads", String(config.server.threads),
    "--host", config.server.internalHost,
    "--port", String(config.server.internalPort)
  ];

  if (!managedExpertMajorV2) {
    args.unshift("--metal");
    args.push("--power", String(config.server.powerPercent));
  }

  // The unified ExpertMajor v2 runtime owns backend and residency selection for
  // Qwen, DeepSeek, and GLM. DSBox supplies no backend, power, streaming, cache,
  // preload, or cold-start overrides on the normal managed path.
  if (config.streaming.enabled && !managedExpertMajorV2) {
    args.push("--ssd-streaming");
    if (!advancedCacheOverride && config.streaming.cacheMode === "manual") {
      args.push("--ssd-streaming-cache-experts", `${config.streaming.cacheSizeGb}GB`);
    }
    if (config.streaming.coldStart) args.push("--ssd-streaming-cold");
    if (config.streaming.preloadExperts !== null) {
      args.push("--ssd-streaming-preload-experts", String(config.streaming.preloadExperts));
    }
  }

  if (!qwen35 && !glm52 && config.server.prefillChunk !== null && !advancedPrefillOverride) {
    args.push("--prefill-chunk", String(config.server.prefillChunk));
  }
  if (!managedExpertMajorV2 && config.server.quality) args.push("--quality");
  if (!managedExpertMajorV2 && config.server.warmWeights) args.push("--warm-weights");

  // Qwen keeps the active context in memory but cannot serialize its recurrent
  // session payload yet. DeepSeek and GLM retain the supported disk-KV path.
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
  if (!qwen35 && !glm52 && config.observability.imatrixEnabled) {
    args.push(
      "--imatrix-out", config.observability.imatrixPath,
      "--imatrix-every", String(config.observability.imatrixEvery)
    );
  }

  args.push(...extraArgs);
  return args;
}
