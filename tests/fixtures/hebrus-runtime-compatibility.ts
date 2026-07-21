import type { DsboxConfig } from "../../src/types.js";

const persistedBase = {
  version: 2,
  model: {
    path: "/Volumes/Models/DS4/DeepSeek-V4-Flash-DS4-ExpertMajor-v2.gguf",
    id: "deepseek-v4-flash"
  },
  server: {
    internalHost: "127.0.0.1",
    internalPort: 8123,
    contextTokens: 65_536,
    maxOutputTokens: 16_384,
    powerPercent: 73,
    threads: 12,
    prefillChunk: 2_048,
    quality: true,
    warmWeights: true
  },
  streaming: {
    enabled: true,
    cacheMode: "manual",
    cacheSizeGb: 21,
    coldStart: true,
    preloadExperts: 777
  },
  kvCache: {
    enabled: true,
    directory: "/Volumes/Inference Cache/DSBox/kv",
    spaceMb: 12_345,
    minTokens: 321,
    continuedIntervalTokens: 7_654
  },
  observability: {
    traceEnabled: true,
    tracePath: "/Volumes/Inference Logs/DSBox/custom.trace",
    imatrixEnabled: true,
    imatrixPath: "/Volumes/Inference Data/DSBox/custom-imatrix.dat",
    imatrixEvery: 23
  },
  gateway: {
    requireApiKey: true,
    apiKey: "fixture-secret-key"
  },
  advanced: {
    extraArgs: "--trace /Volumes/Inference Logs/DSBox/runtime.trace",
    environment: "DS4_METAL_MEMORY_REPORT=1\nFIXTURE_VALUE=preserve-me"
  }
} as const;

export const persistedConfigFixtures = [
  {
    name: "legacy DS4 checkout",
    config: {
      ...persistedBase,
      repository: {
        url: "https://github.com/andreaborio/ds4.git",
        branch: "main",
        directory: "/Volumes/Fast SSD/Inference/ds4-production"
      }
    } satisfies DsboxConfig
  },
  {
    name: "Hebrus checkout with existing DS4 artifact paths",
    config: {
      ...persistedBase,
      repository: {
        url: "https://github.com/andreaborio/hebrus.git",
        branch: "main",
        directory: "/Users/alice/Developer/hebrus"
      }
    } satisfies DsboxConfig
  }
] as const;

function capabilityDocument(engineId: "ds4" | "hebrus", schemaVersion = 1) {
  return {
    schema_version: schemaVersion,
    engine_id: engineId,
    build_git_sha: "bcfca93b2ab7",
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

export const runtimeCompatibilityMatrix = [
  {
    name: "legacy ds4-server without capabilities",
    remote: "https://github.com/andreaborio/ds4.git",
    binaryName: "ds4-server",
    capability: null,
    expected: "legacy"
  },
  {
    name: "current DS4 structured capability",
    remote: "git@github.com:andreaborio/ds4.git",
    binaryName: "ds4-server",
    capability: capabilityDocument("ds4"),
    expected: "structured"
  },
  {
    name: "Hebrus alias structured capability",
    remote: "ssh://git@github.com/andreaborio/hebrus",
    binaryName: "hebrus-server",
    capability: capabilityDocument("hebrus"),
    expected: "structured"
  },
  {
    name: "Hebrus capability with unknown schema",
    remote: "https://github.com/andreaborio/hebrus.git",
    binaryName: "hebrus-server",
    capability: capabilityDocument("hebrus", 2),
    expected: "reject"
  },
  {
    name: "capability-less Hebrus binary",
    remote: "https://github.com/andreaborio/hebrus.git",
    binaryName: "hebrus-server",
    capability: null,
    expected: "reject"
  }
] as const;
