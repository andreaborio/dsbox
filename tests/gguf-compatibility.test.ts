import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DS4_DEEPSEEK4_TENSOR_SIGNATURE,
  inspectDs4Gguf
} from "../server/gguf-compatibility.js";

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
  it("accepts a DS4-native DeepSeek 4 directory without reading tensor payload", async () => {
    const result = await inspect(fixture());

    expect(result).toMatchObject({
      compatible: true,
      ggufVersion: 3,
      tensorCount: DS4_DEEPSEEK4_TENSOR_SIGNATURE.length,
      architecture: "deepseek4",
      splitCount: null,
      reason: null
    });
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
    const result = await inspect(fixture({ omitMetadata: "deepseek4.vocab_size" }));

    expect(result.reason).toMatchObject({
      code: "missing_metadata",
      missingKeys: ["deepseek4.vocab_size"]
    });
    expect(result.reason?.message).toContain("deepseek4.vocab_size");
  });

  it("rejects glm-dsa because the currently bundled DS4 runtime is DeepSeek-only", async () => {
    const result = await inspect(fixture({ architecture: "glm-dsa" }));

    expect(result.reason?.code).toBe("unsupported_architecture");
    expect(result.reason?.message).toContain("glm-dsa");
  });

  it("requires a DS4-native tensor signature", async () => {
    const result = await inspect(fixture({ tensors: DS4_DEEPSEEK4_TENSOR_SIGNATURE.slice(0, -1) }));

    expect(result.reason).toMatchObject({
      code: "missing_tensor_signature",
      missingKeys: ["blk.0.ffn_gate_exps.weight"]
    });
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
