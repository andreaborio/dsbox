import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DS4_DEEPSEEK4_TENSOR_SIGNATURE,
  DS4_DEEPSEEK4_NATIVE_TENSOR_SIGNATURE,
  DS4_GLM52_EXPERT_STORE_BYTES,
  DS4_GLM52_NATIVE_TENSOR_COUNT,
  DS4_GLM52_NATIVE_TENSOR_SIGNATURE,
  DS4_QWEN35MOE_EXPERT_STORE_BYTES,
  DS4_QWEN35MOE_NATIVE_TENSOR_COUNT,
  DS4_QWEN35MOE_TENSOR_SIGNATURE,
  DS4_QWEN35MOE_NATIVE_TENSOR_SIGNATURE,
  inspectDs4Gguf
} from "../server/gguf-compatibility.js";
import {
  createDs4Glm52GgufFixture,
  createDs4GgufFixture,
  createDs4QwenGgufFixture
} from "./helpers/gguf.js";

const U32 = 4;
const F32 = 6;
const BOOL = 7;
const STRING = 8;
const ARRAY = 9;

function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function f32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeFloatLE(value);
  return buffer;
}

function string(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([u64(bytes.length), bytes]);
}

function metadata(key: string, type: number, value: Buffer): Buffer {
  return Buffer.concat([string(key), u32(type), value]);
}

function stringValue(key: string, value: string): Buffer {
  return metadata(key, STRING, string(value));
}

function u32Value(key: string, value = 1): Buffer {
  return metadata(key, U32, u32(value));
}

function f32Value(key: string, value = 1): Buffer {
  return metadata(key, F32, f32(value));
}

function boolValue(key: string, value = true): Buffer {
  return metadata(key, BOOL, Buffer.from([Number(value)]));
}

function arrayValue(key: string, elementType: number, values: Buffer[]): Buffer {
  return metadata(key, ARRAY, Buffer.concat([u32(elementType), u64(values.length), ...values]));
}

const U32_KEYS = [
  "deepseek4.block_count",
  "deepseek4.embedding_length",
  "deepseek4.vocab_size",
  "deepseek4.attention.head_count",
  "deepseek4.attention.head_count_kv",
  "deepseek4.attention.key_length",
  "deepseek4.attention.value_length",
  "deepseek4.rope.dimension_count",
  "deepseek4.attention.q_lora_rank",
  "deepseek4.attention.output_lora_rank",
  "deepseek4.attention.output_group_count",
  "deepseek4.expert_count",
  "deepseek4.expert_used_count",
  "deepseek4.expert_feed_forward_length",
  "deepseek4.expert_shared_count",
  "deepseek4.hash_layer_count",
  "deepseek4.attention.sliding_window",
  "deepseek4.attention.indexer.head_count",
  "deepseek4.attention.indexer.key_length",
  "deepseek4.attention.indexer.top_k",
  "deepseek4.hyper_connection.count",
  "deepseek4.hyper_connection.sinkhorn_iterations"
];

const F32_KEYS = [
  "deepseek4.rope.freq_base",
  "deepseek4.attention.compress_rope_freq_base",
  "deepseek4.expert_weights_scale",
  "deepseek4.attention.layer_norm_rms_epsilon",
  "deepseek4.hyper_connection.epsilon"
];

interface FixtureOptions {
  architecture?: string;
  omitMetadata?: string;
  splitCount?: number;
  tensors?: readonly string[];
  version?: number;
}

function fixture(options: FixtureOptions = {}): Buffer {
  const entries = [
    stringValue("general.architecture", options.architecture ?? "deepseek4"),
    ...U32_KEYS.map((key) => u32Value(key)),
    ...F32_KEYS.map((key) => f32Value(key)),
    boolValue("deepseek4.expert_weights_norm"),
    arrayValue("deepseek4.attention.compress_ratios", U32, [u32(1)]),
    arrayValue("deepseek4.swiglu_clamp_exp", F32, [f32(1)]),
    arrayValue("tokenizer.ggml.tokens", STRING, [string("token")]),
    arrayValue("tokenizer.ggml.merges", STRING, [string("merge")])
  ];
  if (options.splitCount !== undefined) entries.push(u32Value("split.count", options.splitCount));
  const filtered = options.omitMetadata
    ? entries.filter((entry) => {
      const keyLength = Number(entry.readBigUInt64LE(0));
      return entry.subarray(8, 8 + keyLength).toString() !== options.omitMetadata;
    })
    : entries;
  const tensors = options.tensors ?? DS4_DEEPSEEK4_TENSOR_SIGNATURE;
  const tensorDirectory = tensors.map((name) => Buffer.concat([
    string(name),
    u32(1),
    u64(1),
    u32(0),
    u64(0)
  ]));
  return Buffer.concat([
    Buffer.from("GGUF"),
    u32(options.version ?? 3),
    u64(tensors.length),
    u64(filtered.length),
    ...filtered,
    ...tensorDirectory
  ]);
}

const directories: string[] = [];

async function inspect(bytes: Buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsbox-gguf-compat-"));
  directories.push(directory);
  const modelPath = path.join(directory, "model.gguf");
  await writeFile(modelPath, bytes);
  return inspectDs4Gguf(modelPath);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DS4 GGUF compatibility inspection", () => {
  it("rejects the former canonical DeepSeek 4 directory", async () => {
    const result = await inspect(fixture());

    expect(result).toMatchObject({
      compatible: false,
      ggufVersion: 3,
      tensorCount: DS4_DEEPSEEK4_TENSOR_SIGNATURE.length,
      architecture: "deepseek4",
      splitCount: null,
      artifactFormat: null,
      reason: { code: "missing_tensor_signature" }
    });
    expect(result.reason?.message).toContain("ExpertMajor v2");
  });

  it("recognizes the DS4-only DeepSeek ExpertMajor v2 tensor contract", async () => {
    const result = await inspect(createDs4GgufFixture({ nativeExpertMajorV2: true }));

    expect(result).toMatchObject({
      compatible: true,
      architecture: "deepseek4",
      artifactFormat: "ds4-expert-major-v2",
      tensorCount: DS4_DEEPSEEK4_NATIVE_TENSOR_SIGNATURE.length + 1,
      reason: null
    });
  });

  it("recognizes the pinned GLM-5.2 ExpertMajor v2 header without reading tensor payload", async () => {
    const result = await inspect(createDs4Glm52GgufFixture());

    expect(result).toMatchObject({
      compatible: true,
      ggufVersion: 3,
      architecture: "glm-dsa",
      artifactFormat: "ds4-expert-major-v2",
      tensorCount: DS4_GLM52_NATIVE_TENSOR_COUNT,
      reason: null
    });
    expect(DS4_GLM52_NATIVE_TENSOR_SIGNATURE).toHaveLength(25);
    expect(DS4_GLM52_EXPERT_STORE_BYTES).toBe(240_987_951_104);
  });

  it("rejects a GLM ExpertMajor artifact with a different pinned model geometry", async () => {
    const result = await inspect(createDs4Glm52GgufFixture({ expertCount: 255 }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "invalid_metadata_type",
      invalidKeys: ["glm-dsa.expert_count"]
    });
  });

  it("rejects a GLM chat template with the correct length but the wrong digest", async () => {
    const result = await inspect(createDs4Glm52GgufFixture({ invalidChatTemplate: true }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "invalid_metadata_type",
      invalidKeys: ["tokenizer.chat_template"]
    });
  });

  it("rejects a GLM token-type table with the correct length but the wrong digest", async () => {
    const result = await inspect(createDs4Glm52GgufFixture({ invalidTokenTypes: true }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "invalid_metadata_type",
      invalidKeys: ["tokenizer.ggml.token_type"]
    });
  });

  it("rejects a GLM ExpertMajor store with a different byte extent", async () => {
    const result = await inspect(createDs4Glm52GgufFixture({ expertStoreBytes: 4096 }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "missing_tensor_signature",
      invalidKeys: ["ds4.expert_major.v2"]
    });
  });

  it("rejects a GLM GGUF that mixes the native store with canonical routed tensors", async () => {
    const result = await inspect(createDs4Glm52GgufFixture({ includeCanonicalRoutedTensor: true }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "missing_tensor_signature",
      invalidKeys: ["blk.3.ffn_gate_exps.weight"]
    });
  });

  it("recognizes the pinned Qwen3.6 ExpertMajor v2 header", async () => {
    const result = await inspect(createDs4QwenGgufFixture());

    expect(result).toMatchObject({
      compatible: true,
      ggufVersion: 3,
      tensorCount: DS4_QWEN35MOE_NATIVE_TENSOR_COUNT,
      architecture: "qwen35moe",
      splitCount: null,
      artifactFormat: "ds4-expert-major-v2",
      reason: null
    });
    expect(DS4_QWEN35MOE_TENSOR_SIGNATURE).toHaveLength(733);
    expect(DS4_QWEN35MOE_NATIVE_TENSOR_SIGNATURE).toHaveLength(613);
    expect(DS4_QWEN35MOE_EXPERT_STORE_BYTES).toBe(18_119_405_568);
  });

  it("rejects the retired Qwen ExpertMajor v2 GGML/Q4 payload", async () => {
    const result = await inspect(createDs4QwenGgufFixture({ expertStorage: "ggml" }));

    expect(result.compatible).toBe(false);
    expect(result.artifactFormat).toBe("ds4-expert-major-v2");
    expect(result.reason).toMatchObject({
      code: "missing_tensor_signature",
      invalidKeys: ["ds4.expert_major.v2"]
    });
    expect(result.reason?.message).toContain("MLX affine4/group-64");
  });

  it("rejects the legacy Qwen ExpertMajor v1 tensor contract", async () => {
    const result = await inspect(createDs4QwenGgufFixture({ legacyExpertMajorV1: true }));

    expect(result.compatible).toBe(false);
    expect(result.artifactFormat).toBeNull();
    expect(result.reason).toMatchObject({ code: "missing_tensor_signature" });
    expect(result.reason?.message).toContain("v1 is no longer runnable");
  });

  it("rejects the canonical Qwen tensor contract", async () => {
    const result = await inspect(createDs4QwenGgufFixture({ canonical: true }));

    expect(result.compatible).toBe(false);
    expect(result.artifactFormat).toBeNull();
    expect(result.reason?.message).toContain("ExpertMajor v2");
  });

  it("rejects a Qwen ExpertMajor store with a different routed payload extent", async () => {
    const result = await inspect(createDs4QwenGgufFixture({ expertStoreBytes: 4096 }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "missing_tensor_signature",
      invalidKeys: ["ds4.expert_major.v2"]
    });
  });

  it("rejects Qwen ExpertMajor v2 mixed with canonical routed tensors", async () => {
    const result = await inspect(createDs4QwenGgufFixture({ includeCanonicalRoutedTensor: true }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "missing_tensor_signature",
      invalidKeys: ["blk.0.ffn_gate_exps.weight"]
    });
  });

  it("rejects a Qwen v2 artifact whose non-routed output tensor is not normalized", async () => {
    const result = await inspect(createDs4QwenGgufFixture({ rawUnslothLayout: true }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "missing_tensor_signature",
      invalidKeys: ["output.weight"]
    });
    expect(result.reason?.message).toContain("not normalized");
  });

  it("rejects the raw Unsloth Qwen padding token metadata", async () => {
    const result = await inspect(createDs4QwenGgufFixture({ paddingTokenId: 248_055 }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "invalid_metadata_type",
      invalidKeys: ["tokenizer.ggml.padding_token_id"]
    });
    expect(result.reason?.message).toContain("pinned metadata contract");
  });

  it("rejects a Qwen chat template with the correct length but the wrong digest", async () => {
    const result = await inspect(createDs4QwenGgufFixture({ invalidChatTemplate: true }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toMatchObject({
      code: "invalid_metadata_type",
      invalidKeys: ["tokenizer.chat_template"]
    });
    expect(result.reason?.message).toContain("pinned metadata contract");
  });

  it("rejects a standard multipart shard before its empty tensor directory", async () => {
    const result = await inspect(fixture({ splitCount: 3, tensors: [] }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toEqual({
      code: "multipart_unsupported",
      message: "DS4 does not support standard multi-file GGUF sets. Choose a single DS4-native GGUF instead."
    });
  });

  it("rejects metadata-only GGUF files", async () => {
    const result = await inspect(fixture({ tensors: [] }));

    expect(result.reason?.code).toBe("empty_tensor_directory");
  });

  it("reports the missing deepseek4.vocab_size key explicitly", async () => {
    const result = await inspect(createDs4GgufFixture({ includeVocabSize: false }));

    expect(result.reason).toMatchObject({
      code: "missing_metadata",
      missingKeys: ["deepseek4.vocab_size"]
    });
    expect(result.reason?.message).toContain("deepseek4.vocab_size");
  });

  it("rejects canonical glm-dsa files while only the pinned ExpertMajor v2 layout is qualified", async () => {
    const result = await inspect(fixture({ architecture: "glm-dsa" }));

    expect(result.reason?.code).toBe("missing_tensor_signature");
    expect(result.reason?.message).toContain("ExpertMajor v2");
  });

  it("rejects a canonical DeepSeek tensor signature even when its metadata is complete", async () => {
    const result = await inspect(fixture({ tensors: DS4_DEEPSEEK4_TENSOR_SIGNATURE.slice(0, -1) }));

    expect(result.reason?.code).toBe("missing_tensor_signature");
    expect(result.reason?.message).toContain("ExpertMajor v2");
  });

  it("rejects older GGUF formats before parsing metadata", async () => {
    const result = await inspect(fixture({ version: 2 }));

    expect(result.reason?.code).toBe("unsupported_gguf_version");
  });

  it("returns a structured error for a truncated directory", async () => {
    const result = await inspect(fixture().subarray(0, -4));

    expect(result.reason?.code).toBe("invalid_gguf");
    expect(result.reason?.message).toContain("truncated");
  });
});
