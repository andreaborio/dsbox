import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { Ds4ArtifactFormat } from "../src/types.js";
import { ds4ArtifactFormatTensor } from "../src/lib/model-format.js";

const GGUF_HEADER_BYTES = 24;
const GGUF_VERSION = 3;
const MAX_METADATA_ENTRIES = 100_000;
const MAX_TENSORS = 1_000_000;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_NAME_BYTES = 1024 * 1024;
const MAX_ARRAY_ITEMS = 5_000_000;
const READ_BUFFER_BYTES = 64 * 1024;
const GGUF_DEFAULT_ALIGNMENT = 32;
const EXPERT_MAJOR_V2_HEADER_PROBE_BYTES = 168;
const EXPERT_MAJOR_V2_MAGIC = "DS4EXPV2";
const EXPERT_MAJOR_STORAGE_MLX_AFFINE4 = 1;
const EXPERT_MAJOR_MLX_GROUP_SIZE = 64;

const GGUF_TYPE = {
  uint8: 0,
  int8: 1,
  uint16: 2,
  int16: 3,
  uint32: 4,
  int32: 5,
  float32: 6,
  bool: 7,
  string: 8,
  array: 9,
  uint64: 10,
  int64: 11,
  float64: 12
} as const;

const FIXED_VALUE_BYTES = new Map<number, number>([
  [GGUF_TYPE.uint8, 1],
  [GGUF_TYPE.int8, 1],
  [GGUF_TYPE.uint16, 2],
  [GGUF_TYPE.int16, 2],
  [GGUF_TYPE.uint32, 4],
  [GGUF_TYPE.int32, 4],
  [GGUF_TYPE.float32, 4],
  [GGUF_TYPE.bool, 1],
  [GGUF_TYPE.uint64, 8],
  [GGUF_TYPE.int64, 8],
  [GGUF_TYPE.float64, 8]
]);

type MetadataExpectation = "u32" | "f32" | "bool" | "string" | "string-array" | "i32-array" | "int-array" | "float-array";

const DEEPSEEK4_METADATA = new Map<string, MetadataExpectation>([
  ["deepseek4.block_count", "u32"],
  ["deepseek4.embedding_length", "u32"],
  ["deepseek4.vocab_size", "u32"],
  ["deepseek4.attention.head_count", "u32"],
  ["deepseek4.attention.head_count_kv", "u32"],
  ["deepseek4.attention.key_length", "u32"],
  ["deepseek4.attention.value_length", "u32"],
  ["deepseek4.rope.dimension_count", "u32"],
  ["deepseek4.attention.q_lora_rank", "u32"],
  ["deepseek4.attention.output_lora_rank", "u32"],
  ["deepseek4.attention.output_group_count", "u32"],
  ["deepseek4.expert_count", "u32"],
  ["deepseek4.expert_used_count", "u32"],
  ["deepseek4.expert_feed_forward_length", "u32"],
  ["deepseek4.expert_shared_count", "u32"],
  ["deepseek4.hash_layer_count", "u32"],
  ["deepseek4.attention.sliding_window", "u32"],
  ["deepseek4.attention.indexer.head_count", "u32"],
  ["deepseek4.attention.indexer.key_length", "u32"],
  ["deepseek4.attention.indexer.top_k", "u32"],
  ["deepseek4.hyper_connection.count", "u32"],
  ["deepseek4.hyper_connection.sinkhorn_iterations", "u32"],
  ["deepseek4.rope.freq_base", "f32"],
  ["deepseek4.attention.compress_rope_freq_base", "f32"],
  ["deepseek4.expert_weights_scale", "f32"],
  ["deepseek4.attention.layer_norm_rms_epsilon", "f32"],
  ["deepseek4.hyper_connection.epsilon", "f32"],
  ["deepseek4.expert_weights_norm", "bool"],
  ["deepseek4.attention.compress_ratios", "int-array"],
  ["deepseek4.swiglu_clamp_exp", "float-array"],
  ["tokenizer.ggml.tokens", "string-array"],
  ["tokenizer.ggml.merges", "string-array"]
]);

const QWEN35MOE_METADATA = new Map<string, MetadataExpectation>([
  ["qwen35moe.block_count", "u32"],
  ["qwen35moe.context_length", "u32"],
  ["qwen35moe.embedding_length", "u32"],
  ["qwen35moe.attention.head_count", "u32"],
  ["qwen35moe.attention.head_count_kv", "u32"],
  ["qwen35moe.attention.key_length", "u32"],
  ["qwen35moe.attention.value_length", "u32"],
  ["qwen35moe.rope.dimension_count", "u32"],
  ["qwen35moe.rope.dimension_sections", "i32-array"],
  ["qwen35moe.rope.freq_base", "f32"],
  ["qwen35moe.attention.layer_norm_rms_epsilon", "f32"],
  ["qwen35moe.expert_count", "u32"],
  ["qwen35moe.expert_used_count", "u32"],
  ["qwen35moe.expert_feed_forward_length", "u32"],
  ["qwen35moe.expert_shared_feed_forward_length", "u32"],
  ["qwen35moe.ssm.conv_kernel", "u32"],
  ["qwen35moe.ssm.state_size", "u32"],
  ["qwen35moe.ssm.group_count", "u32"],
  ["qwen35moe.ssm.time_step_rank", "u32"],
  ["qwen35moe.ssm.inner_size", "u32"],
  ["qwen35moe.full_attention_interval", "u32"],
  ["tokenizer.ggml.model", "string"],
  ["tokenizer.ggml.pre", "string"],
  ["tokenizer.ggml.tokens", "string-array"],
  ["tokenizer.ggml.token_type", "i32-array"],
  ["tokenizer.ggml.merges", "string-array"],
  ["tokenizer.ggml.bos_token_id", "u32"],
  ["tokenizer.ggml.padding_token_id", "u32"],
  ["tokenizer.ggml.eos_token_id", "u32"],
  ["tokenizer.ggml.add_bos_token", "bool"],
  ["tokenizer.chat_template", "string"]
]);

const QWEN35MOE_EXACT_VALUES = new Map<string, string | number | boolean>([
  ["qwen35moe.block_count", 40],
  ["qwen35moe.context_length", 262_144],
  ["qwen35moe.embedding_length", 2048],
  ["qwen35moe.attention.head_count", 16],
  ["qwen35moe.attention.head_count_kv", 2],
  ["qwen35moe.attention.key_length", 256],
  ["qwen35moe.attention.value_length", 256],
  ["qwen35moe.rope.dimension_count", 64],
  ["qwen35moe.rope.freq_base", 10_000_000],
  ["qwen35moe.attention.layer_norm_rms_epsilon", 1e-6],
  ["qwen35moe.expert_count", 256],
  ["qwen35moe.expert_used_count", 8],
  ["qwen35moe.expert_feed_forward_length", 512],
  ["qwen35moe.expert_shared_feed_forward_length", 512],
  ["qwen35moe.ssm.conv_kernel", 4],
  ["qwen35moe.ssm.state_size", 128],
  ["qwen35moe.ssm.group_count", 16],
  ["qwen35moe.ssm.time_step_rank", 32],
  ["qwen35moe.ssm.inner_size", 4096],
  ["qwen35moe.full_attention_interval", 4],
  ["qwen35moe.nextn_predict_layers", 0],
  ["tokenizer.ggml.model", "gpt2"],
  ["tokenizer.ggml.pre", "qwen35"],
  ["tokenizer.ggml.bos_token_id", 248_044],
  ["tokenizer.ggml.padding_token_id", 248_044],
  ["tokenizer.ggml.eos_token_id", 248_046],
  ["tokenizer.ggml.add_bos_token", false]
]);

const QWEN35MOE_ARRAY_LENGTHS = new Map<string, number>([
  ["qwen35moe.rope.dimension_sections", 4],
  ["tokenizer.ggml.tokens", 248_320],
  ["tokenizer.ggml.token_type", 248_320],
  ["tokenizer.ggml.merges", 247_587]
]);

const QWEN35MOE_ROPE_SECTIONS = [11, 11, 10, 0] as const;
const QWEN35MOE_CHAT_TEMPLATE_BYTES = 7764;
const QWEN35MOE_CHAT_TEMPLATE_SHA256 = "e84f32a23fdda27689f868aa4a1a5621f41133e51a48d7f3efcbea2839574259";
const QWEN35MOE_RECURRENT_LAYERS_KEY = "qwen35moe.attention.recurrent_layers";

const GLM52_METADATA = new Map<string, MetadataExpectation>([
  ["glm-dsa.block_count", "u32"],
  ["glm-dsa.context_length", "u32"],
  ["glm-dsa.embedding_length", "u32"],
  ["glm-dsa.feed_forward_length", "u32"],
  ["glm-dsa.attention.head_count", "u32"],
  ["glm-dsa.attention.head_count_kv", "u32"],
  ["glm-dsa.attention.key_length", "u32"],
  ["glm-dsa.attention.value_length", "u32"],
  ["glm-dsa.attention.q_lora_rank", "u32"],
  ["glm-dsa.attention.kv_lora_rank", "u32"],
  ["glm-dsa.attention.key_length_mla", "u32"],
  ["glm-dsa.attention.value_length_mla", "u32"],
  ["glm-dsa.attention.layer_norm_rms_epsilon", "f32"],
  ["glm-dsa.rope.dimension_count", "u32"],
  ["glm-dsa.rope.freq_base", "f32"],
  ["glm-dsa.rope.interleave", "bool"],
  ["glm-dsa.expert_count", "u32"],
  ["glm-dsa.expert_used_count", "u32"],
  ["glm-dsa.expert_group_count", "u32"],
  ["glm-dsa.expert_group_used_count", "u32"],
  ["glm-dsa.expert_gating_func", "u32"],
  ["glm-dsa.expert_feed_forward_length", "u32"],
  ["glm-dsa.expert_shared_count", "u32"],
  ["glm-dsa.expert_weights_scale", "f32"],
  ["glm-dsa.expert_weights_norm", "bool"],
  ["glm-dsa.leading_dense_block_count", "u32"],
  ["glm-dsa.nextn_predict_layers", "u32"],
  ["glm-dsa.vocab_size", "u32"],
  ["glm-dsa.attention.indexer.head_count", "u32"],
  ["glm-dsa.attention.indexer.key_length", "u32"],
  ["glm-dsa.attention.indexer.top_k", "u32"],
  ["glm-dsa.attention.indexer.top_k_freq", "u32"],
  ["glm-dsa.attention.indexer.skip_top_k_offset", "u32"],
  ["glm-dsa.attention.indexer.share_for_mtp_iteration", "bool"],
  ["glm-dsa.attention.indexer.rope_interleave", "bool"],
  ["tokenizer.ggml.model", "string"],
  ["tokenizer.ggml.pre", "string"],
  ["tokenizer.ggml.tokens", "string-array"],
  ["tokenizer.ggml.token_type", "i32-array"],
  ["tokenizer.ggml.merges", "string-array"],
  ["tokenizer.ggml.eos_token_id", "u32"],
  ["tokenizer.ggml.padding_token_id", "u32"],
  ["tokenizer.ggml.bos_token_id", "u32"],
  ["tokenizer.ggml.eot_token_id", "u32"],
  ["tokenizer.ggml.unknown_token_id", "u32"],
  ["tokenizer.ggml.eom_token_id", "u32"],
  ["tokenizer.chat_template", "string"]
]);

const GLM52_EXACT_VALUES = new Map<string, string | number | boolean>([
  ["glm-dsa.block_count", 79],
  ["glm-dsa.context_length", 1_048_576],
  ["glm-dsa.embedding_length", 6144],
  ["glm-dsa.feed_forward_length", 12_288],
  ["glm-dsa.attention.head_count", 64],
  ["glm-dsa.attention.head_count_kv", 1],
  ["glm-dsa.attention.key_length", 576],
  ["glm-dsa.attention.value_length", 512],
  ["glm-dsa.attention.q_lora_rank", 2048],
  ["glm-dsa.attention.kv_lora_rank", 512],
  ["glm-dsa.attention.key_length_mla", 256],
  ["glm-dsa.attention.value_length_mla", 256],
  ["glm-dsa.attention.layer_norm_rms_epsilon", 1e-5],
  ["glm-dsa.rope.dimension_count", 64],
  ["glm-dsa.rope.freq_base", 8_000_000],
  ["glm-dsa.rope.interleave", true],
  ["glm-dsa.expert_count", 256],
  ["glm-dsa.expert_used_count", 8],
  ["glm-dsa.expert_group_count", 1],
  ["glm-dsa.expert_group_used_count", 1],
  ["glm-dsa.expert_gating_func", 2],
  ["glm-dsa.expert_feed_forward_length", 2048],
  ["glm-dsa.expert_shared_count", 1],
  ["glm-dsa.expert_weights_scale", 2.5],
  ["glm-dsa.expert_weights_norm", true],
  ["glm-dsa.leading_dense_block_count", 3],
  ["glm-dsa.nextn_predict_layers", 1],
  ["glm-dsa.vocab_size", 154_880],
  ["glm-dsa.attention.indexer.head_count", 32],
  ["glm-dsa.attention.indexer.key_length", 128],
  ["glm-dsa.attention.indexer.top_k", 2048],
  ["glm-dsa.attention.indexer.top_k_freq", 4],
  ["glm-dsa.attention.indexer.skip_top_k_offset", 3],
  ["glm-dsa.attention.indexer.share_for_mtp_iteration", true],
  ["glm-dsa.attention.indexer.rope_interleave", true],
  ["tokenizer.ggml.model", "gpt2"],
  ["tokenizer.ggml.pre", "glm4"],
  ["tokenizer.ggml.eos_token_id", 154_820],
  ["tokenizer.ggml.padding_token_id", 154_821],
  ["tokenizer.ggml.bos_token_id", 154_822],
  ["tokenizer.ggml.eot_token_id", 154_827],
  ["tokenizer.ggml.unknown_token_id", 154_820],
  ["tokenizer.ggml.eom_token_id", 154_829]
]);

const GLM52_ARRAY_LENGTHS = new Map<string, number>([
  ["tokenizer.ggml.tokens", 154_880],
  ["tokenizer.ggml.token_type", 154_880],
  ["tokenizer.ggml.merges", 321_649]
]);

const GLM52_CHAT_TEMPLATE_BYTES = 5269;
const GLM52_CHAT_TEMPLATE_SHA256 = "bf78575b301b56fa74337b470f6560d5366ff15378ddf88d623fd0496152fa77";
const GLM52_TOKEN_TYPES_SHA256 = "dee3060106b017abcc4a2fa9ba429287b0cc246eeb00fc2a38fe6c1ad4274b3a";
export const DS4_GLM52_NATIVE_TENSOR_COUNT = 1297;
export const DS4_GLM52_EXPERT_STORE_BYTES = 240_987_951_104;
export const DS4_QWEN35MOE_NATIVE_TENSOR_COUNT = 614;
export const DS4_QWEN35MOE_EXPERT_STORE_BYTES = 18_119_405_568;

export const DS4_DEEPSEEK4_TENSOR_SIGNATURE = [
  "token_embd.weight",
  "output.weight",
  "output_norm.weight",
  "blk.0.attn_q_a.weight",
  "blk.0.ffn_gate_inp.weight",
  "blk.0.ffn_gate_exps.weight"
] as const;

export const DS4_DEEPSEEK4_NATIVE_TENSOR_SIGNATURE = [
  "token_embd.weight",
  "output.weight",
  "output_norm.weight",
  "blk.0.attn_q_a.weight",
  "blk.0.ffn_gate_inp.weight"
] as const;

const GGML_TYPE = {
  f32: 0,
  f16: 1,
  q8_0: 8,
  q4_k: 12,
  i8: 24
} as const;

interface TensorLayoutExpectation {
  dimensions: readonly number[];
  types: readonly number[];
}

interface TensorDescriptor {
  dimensions: number[];
  offset: number;
  type: number;
}

function alignUp(value: number, alignment: number): number {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(alignment) ||
      value < 0 || alignment <= 0 || (alignment & (alignment - 1)) !== 0) {
    throw new GgufParseError("GGUF data alignment is invalid");
  }
  const remainder = value % alignment;
  const aligned = remainder === 0 ? value : value + alignment - remainder;
  if (!Number.isSafeInteger(aligned)) throw new GgufParseError("GGUF data offset is too large");
  return aligned;
}

function createQwen35MoeTensorLayout(): Map<string, TensorLayoutExpectation> {
  const layout = new Map<string, TensorLayoutExpectation>();
  const exact = (name: string, type: number, ...dimensions: number[]) => {
    layout.set(name, { dimensions, types: [type] });
  };
  const dense = (name: string, ...dimensions: number[]) => {
    layout.set(name, { dimensions, types: [GGML_TYPE.f16, GGML_TYPE.q8_0] });
  };

  dense("token_embd.weight", 2048, 248_320);
  exact("output_norm.weight", GGML_TYPE.f32, 2048);
  dense("output.weight", 2048, 248_320);

  for (let layer = 0; layer < 40; layer += 1) {
    const prefix = `blk.${layer}`;
    exact(`${prefix}.attn_norm.weight`, GGML_TYPE.f32, 2048);
    exact(`${prefix}.post_attention_norm.weight`, GGML_TYPE.f32, 2048);

    if ((layer + 1) % 4 === 0) {
      dense(`${prefix}.attn_q.weight`, 2048, 8192);
      dense(`${prefix}.attn_k.weight`, 2048, 512);
      dense(`${prefix}.attn_v.weight`, 2048, 512);
      dense(`${prefix}.attn_output.weight`, 4096, 2048);
      exact(`${prefix}.attn_q_norm.weight`, GGML_TYPE.f32, 256);
      exact(`${prefix}.attn_k_norm.weight`, GGML_TYPE.f32, 256);
    } else {
      dense(`${prefix}.attn_gate.weight`, 2048, 4096);
      dense(`${prefix}.attn_qkv.weight`, 2048, 8192);
      exact(`${prefix}.ssm_a`, GGML_TYPE.f32, 32);
      exact(`${prefix}.ssm_alpha.weight`, GGML_TYPE.f32, 2048, 32);
      exact(`${prefix}.ssm_beta.weight`, GGML_TYPE.f32, 2048, 32);
      exact(`${prefix}.ssm_conv1d.weight`, GGML_TYPE.f32, 4, 8192);
      exact(`${prefix}.ssm_dt.bias`, GGML_TYPE.f32, 32);
      exact(`${prefix}.ssm_norm.weight`, GGML_TYPE.f32, 128);
      dense(`${prefix}.ssm_out.weight`, 4096, 2048);
    }

    exact(`${prefix}.ffn_gate_inp.weight`, GGML_TYPE.f32, 2048, 256);
    exact(`${prefix}.ffn_gate_exps.weight`, GGML_TYPE.q4_k, 2048, 512, 256);
    exact(`${prefix}.ffn_up_exps.weight`, GGML_TYPE.q4_k, 2048, 512, 256);
    exact(`${prefix}.ffn_down_exps.weight`, GGML_TYPE.q4_k, 512, 2048, 256);
    exact(`${prefix}.ffn_gate_inp_shexp.weight`, GGML_TYPE.f32, 2048);
    dense(`${prefix}.ffn_gate_shexp.weight`, 2048, 512);
    dense(`${prefix}.ffn_up_shexp.weight`, 2048, 512);
    dense(`${prefix}.ffn_down_shexp.weight`, 512, 2048);
  }

  return layout;
}

function createGlm52NativeTensorLayout(): Map<string, TensorLayoutExpectation> {
  const layout = new Map<string, TensorLayoutExpectation>();
  const exact = (name: string, type: number, ...dimensions: number[]) => {
    layout.set(name, { dimensions, types: [type] });
  };

  exact("token_embd.weight", GGML_TYPE.f16, 6144, 154_880);
  exact("output_norm.weight", GGML_TYPE.f32, 6144);
  exact("output.weight", GGML_TYPE.q8_0, 6144, 154_880);

  exact("blk.0.attn_norm.weight", GGML_TYPE.f32, 6144);
  exact("blk.0.attn_q_a.weight", GGML_TYPE.q8_0, 6144, 2048);
  exact("blk.0.attn_q_b.weight", GGML_TYPE.q8_0, 2048, 16_384);
  exact("blk.0.attn_kv_a_mqa.weight", GGML_TYPE.q8_0, 6144, 576);
  exact("blk.0.attn_k_b.weight", GGML_TYPE.q8_0, 192, 512, 64);
  exact("blk.0.attn_v_b.weight", GGML_TYPE.q8_0, 512, 256, 64);
  exact("blk.0.attn_output.weight", GGML_TYPE.q8_0, 16_384, 6144);
  exact("blk.0.ffn_gate.weight", GGML_TYPE.q8_0, 6144, 12_288);
  exact("blk.0.ffn_up.weight", GGML_TYPE.q8_0, 6144, 12_288);
  exact("blk.0.ffn_down.weight", GGML_TYPE.q8_0, 12_288, 6144);

  exact("blk.3.ffn_gate_inp.weight", GGML_TYPE.f16, 6144, 256);
  exact("blk.3.exp_probs_b.bias", GGML_TYPE.f32, 256);
  exact("blk.3.ffn_gate_shexp.weight", GGML_TYPE.q8_0, 6144, 2048);
  exact("blk.3.ffn_up_shexp.weight", GGML_TYPE.q8_0, 6144, 2048);
  exact("blk.3.ffn_down_shexp.weight", GGML_TYPE.q8_0, 2048, 6144);

  exact("blk.78.indexer.attn_q_b.weight", GGML_TYPE.q8_0, 2048, 4096);
  exact("blk.78.indexer.attn_k.weight", GGML_TYPE.q8_0, 6144, 128);
  exact("blk.78.indexer.proj.weight", GGML_TYPE.q8_0, 6144, 32);
  exact("blk.78.eh_proj.weight", GGML_TYPE.f16, 12_288, 6144);
  exact("blk.78.enorm.weight", GGML_TYPE.f32, 6144);
  exact("blk.78.hnorm.weight", GGML_TYPE.f32, 6144);
  exact("blk.78.shared_head.norm.weight", GGML_TYPE.f32, 6144);

  return layout;
}

const QWEN35MOE_TENSOR_LAYOUT = createQwen35MoeTensorLayout();
const QWEN35MOE_ROUTED_TENSOR = /^blk\.\d+\.ffn_(?:gate|up|down)_exps\.weight$/;
const QWEN35MOE_NATIVE_TENSOR_LAYOUT = new Map(
  [...QWEN35MOE_TENSOR_LAYOUT].filter(([name]) => !QWEN35MOE_ROUTED_TENSOR.test(name))
);
const GLM52_NATIVE_TENSOR_LAYOUT = createGlm52NativeTensorLayout();

export const DS4_QWEN35MOE_TENSOR_SIGNATURE = [...QWEN35MOE_TENSOR_LAYOUT.keys()] as readonly string[];
export const DS4_QWEN35MOE_NATIVE_TENSOR_SIGNATURE = [...QWEN35MOE_NATIVE_TENSOR_LAYOUT.keys()] as readonly string[];
export const DS4_GLM52_NATIVE_TENSOR_SIGNATURE = [...GLM52_NATIVE_TENSOR_LAYOUT.keys()] as readonly string[];

export type Ds4GgufCompatibilityReasonCode =
  | "not_gguf"
  | "unsupported_gguf_version"
  | "invalid_gguf"
  | "multipart_unsupported"
  | "empty_tensor_directory"
  | "missing_architecture"
  | "unsupported_architecture"
  | "missing_metadata"
  | "invalid_metadata_type"
  | "missing_tensor_signature"
  | "io_error";

export interface Ds4GgufCompatibilityReason {
  code: Ds4GgufCompatibilityReasonCode;
  message: string;
  missingKeys?: string[];
  invalidKeys?: string[];
}

export interface Ds4GgufCompatibility {
  compatible: boolean;
  ggufVersion: number | null;
  tensorCount: number | null;
  metadataCount: number | null;
  architecture: string | null;
  splitCount: number | null;
  artifactFormat: Ds4ArtifactFormat | null;
  reason: Ds4GgufCompatibilityReason | null;
}

interface MetadataEntry {
  type: number;
  arrayType: number | null;
  value: string | number | boolean | null;
  arrayLength?: number;
  arrayValues?: number[];
  contractMatches?: boolean;
  byteLength?: number;
  sha256?: string;
}

class GgufParseError extends Error {}

class GgufCursor {
  private readonly buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  private bufferStart = -1;
  private bufferLength = 0;
  position: number;

  constructor(
    private readonly handle: FileHandle,
    private readonly fileSize: number,
    position = 0
  ) {
    this.position = position;
  }

  private assertRange(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.position > this.fileSize - length) {
      throw new GgufParseError("GGUF header or directory is truncated");
    }
  }

  private async refill(maxReadAhead: number): Promise<void> {
    const length = Math.min(READ_BUFFER_BYTES, maxReadAhead, this.fileSize - this.position);
    if (length <= 0) throw new GgufParseError("GGUF header or directory is truncated");
    const { bytesRead } = await this.handle.read(this.buffer, 0, length, this.position);
    if (bytesRead <= 0) throw new GgufParseError("GGUF header or directory is truncated");
    this.bufferStart = this.position;
    this.bufferLength = bytesRead;
  }

  async bytes(length: number, safeReadAhead = length): Promise<Buffer> {
    this.assertRange(length);
    if (!Number.isSafeInteger(safeReadAhead) || safeReadAhead < length) {
      throw new GgufParseError("Invalid GGUF directory bounds");
    }
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    let safeRemaining = safeReadAhead;
    while (written < length) {
      const bufferEnd = this.bufferStart + this.bufferLength;
      if (this.position < this.bufferStart || this.position >= bufferEnd) {
        await this.refill(safeRemaining);
      }
      const available = this.bufferStart + this.bufferLength - this.position;
      const count = Math.min(available, length - written);
      this.buffer.copy(result, written, this.position - this.bufferStart, this.position - this.bufferStart + count);
      this.position += count;
      written += count;
      safeRemaining -= count;
    }
    return result;
  }

  skip(length: number): void {
    this.assertRange(length);
    this.position += length;
  }

  async u32(safeReadAhead = 4): Promise<number> {
    return (await this.bytes(4, safeReadAhead)).readUInt32LE(0);
  }

  async u64(safeReadAhead = 8): Promise<bigint> {
    return (await this.bytes(8, safeReadAhead)).readBigUInt64LE(0);
  }
}

function safeNumber(value: bigint, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value > BigInt(maximum)) throw new GgufParseError(`${label} is too large`);
  return Number(value);
}

function fixedValueBytes(type: number): number {
  const length = FIXED_VALUE_BYTES.get(type);
  if (length === undefined) throw new GgufParseError(`Unsupported GGUF metadata type ${type}`);
  return length;
}

async function readStringBytes(cursor: GgufCursor, maximum: number, safeTail: number, capture: boolean): Promise<Buffer | null> {
  const length = safeNumber(await cursor.u64(8 + safeTail), "GGUF string", maximum);
  if (!capture) {
    cursor.skip(length);
    return null;
  }
  return cursor.bytes(length, length + safeTail);
}

async function readString(cursor: GgufCursor, maximum: number, safeTail: number, capture: boolean): Promise<string | null> {
  const bytes = await readStringBytes(cursor, maximum, safeTail, capture);
  return bytes?.toString("utf8") ?? null;
}

async function readInteger(cursor: GgufCursor, type: number, safeTail: number): Promise<number> {
  const size = fixedValueBytes(type);
  const value = await cursor.bytes(size, size + safeTail);
  switch (type) {
    case GGUF_TYPE.uint8: return value.readUInt8(0);
    case GGUF_TYPE.int8: return value.readInt8(0);
    case GGUF_TYPE.uint16: return value.readUInt16LE(0);
    case GGUF_TYPE.int16: return value.readInt16LE(0);
    case GGUF_TYPE.uint32: return value.readUInt32LE(0);
    case GGUF_TYPE.int32: return value.readInt32LE(0);
    case GGUF_TYPE.uint64: return safeNumber(value.readBigUInt64LE(0), "GGUF integer");
    case GGUF_TYPE.int64: {
      const number = value.readBigInt64LE(0);
      if (number < 0n || number > BigInt(Number.MAX_SAFE_INTEGER)) throw new GgufParseError("GGUF integer is out of range");
      return Number(number);
    }
    default: throw new GgufParseError("GGUF metadata value is not an integer");
  }
}

async function readScalar(cursor: GgufCursor, type: number, safeTail: number): Promise<number | boolean> {
  if (type === GGUF_TYPE.float32) {
    return (await cursor.bytes(4, 4 + safeTail)).readFloatLE(0);
  }
  if (type === GGUF_TYPE.float64) {
    return (await cursor.bytes(8, 8 + safeTail)).readDoubleLE(0);
  }
  if (type === GGUF_TYPE.bool) {
    return (await cursor.bytes(1, 1 + safeTail)).readUInt8(0) !== 0;
  }
  return readInteger(cursor, type, safeTail);
}

function minimumMetadataTail(remainingEntries: number, tensorCount: number): number {
  return remainingEntries * 13 + tensorCount * 24;
}

function qwenExpectedTokenType(token: number): number {
  if (token <= 248_043) return 1;
  if (token <= 248_057) return 3;
  if (token <= 248_059) return 4;
  if (token <= 248_065) return 3;
  if (token <= 248_069) return 4;
  if (token <= 248_076) return 3;
  return 5;
}

function qwenTokenTypesMatch(bytes: Buffer): boolean {
  for (let token = 0; token < 248_320; token += 1) {
    if (bytes.readInt32LE(token * 4) !== qwenExpectedTokenType(token)) return false;
  }
  return true;
}

function qwenRecurrentLayersMatch(bytes: Buffer): boolean {
  for (let layer = 0; layer < 40; layer += 1) {
    const expected = (layer + 1) % 4 !== 0;
    if ((bytes.readUInt8(layer) !== 0) !== expected) return false;
  }
  return true;
}

async function readMetadataValue(
  cursor: GgufCursor,
  type: number,
  key: string,
  tailMinimum: number
): Promise<MetadataEntry> {
  if (type === GGUF_TYPE.string) {
    const captureText = key === "general.architecture" ||
      key === "tokenizer.ggml.model" ||
      key === "tokenizer.ggml.pre";
    const captureBytes = captureText || key === "tokenizer.chat_template";
    const bytes = await readStringBytes(cursor, MAX_NAME_BYTES, tailMinimum, captureBytes);
    return {
      type,
      arrayType: null,
      value: captureText ? bytes?.toString("utf8") ?? null : null,
      byteLength: bytes?.length,
      sha256: key === "tokenizer.chat_template" && bytes
        ? createHash("sha256").update(bytes).digest("hex")
        : undefined
    };
  }
  if (type === GGUF_TYPE.array) {
    const arrayType = await cursor.u32(12 + tailMinimum);
    if (arrayType === GGUF_TYPE.array) throw new GgufParseError("Nested GGUF metadata arrays are not supported");
    const count = safeNumber(await cursor.u64(8 + tailMinimum), "GGUF metadata array", MAX_ARRAY_ITEMS);
    let arrayValues: number[] | undefined;
    let contractMatches: boolean | undefined;
    let sha256: string | undefined;
    if (arrayType === GGUF_TYPE.string) {
      for (let index = 0; index < count; index += 1) {
        const remainingStrings = count - index - 1;
        const stringTail = remainingStrings * 8 + tailMinimum;
        await readString(cursor, MAX_NAME_BYTES, stringTail, false);
      }
    } else {
      const byteLength = count * fixedValueBytes(arrayType);
      if (key === "qwen35moe.rope.dimension_sections" &&
          arrayType === GGUF_TYPE.int32 && count === QWEN35MOE_ROPE_SECTIONS.length) {
        const bytes = await cursor.bytes(byteLength, byteLength + tailMinimum);
        arrayValues = Array.from({ length: count }, (_, index) => bytes.readInt32LE(index * 4));
      } else if (key === "tokenizer.ggml.token_type" &&
          arrayType === GGUF_TYPE.int32 && count === 248_320) {
        const bytes = await cursor.bytes(byteLength, byteLength + tailMinimum);
        contractMatches = qwenTokenTypesMatch(bytes);
      } else if (key === "tokenizer.ggml.token_type" &&
          arrayType === GGUF_TYPE.int32 && count === 154_880) {
        const bytes = await cursor.bytes(byteLength, byteLength + tailMinimum);
        sha256 = createHash("sha256").update(bytes).digest("hex");
      } else if (key === QWEN35MOE_RECURRENT_LAYERS_KEY &&
          arrayType === GGUF_TYPE.bool && count === 40) {
        const bytes = await cursor.bytes(byteLength, byteLength + tailMinimum);
        contractMatches = qwenRecurrentLayersMatch(bytes);
      } else {
        cursor.skip(byteLength);
      }
    }
    return { type, arrayType, value: null, arrayLength: count, arrayValues, contractMatches, sha256 };
  }
  if (key === "split.count") {
    return { type, arrayType: null, value: await readInteger(cursor, type, tailMinimum) };
  }
  const capturesExactScalar = (
    QWEN35MOE_EXACT_VALUES.has(key) || GLM52_EXACT_VALUES.has(key)
  ) && type !== GGUF_TYPE.string;
  if (capturesExactScalar) {
    return { type, arrayType: null, value: await readScalar(cursor, type, tailMinimum) };
  }
  cursor.skip(fixedValueBytes(type));
  return { type, arrayType: null, value: null };
}

function expectationMatches(entry: MetadataEntry, expectation: MetadataExpectation): boolean {
  switch (expectation) {
    case "u32": return entry.type === GGUF_TYPE.uint32;
    case "f32": return ([GGUF_TYPE.float32, GGUF_TYPE.float64, GGUF_TYPE.uint32, GGUF_TYPE.int32] as number[]).includes(entry.type);
    case "bool": return entry.type === GGUF_TYPE.bool;
    case "string": return entry.type === GGUF_TYPE.string;
    case "string-array": return entry.type === GGUF_TYPE.array && entry.arrayType === GGUF_TYPE.string;
    case "i32-array": return entry.type === GGUF_TYPE.array && entry.arrayType === GGUF_TYPE.int32;
    case "int-array": return entry.type === GGUF_TYPE.array && ([GGUF_TYPE.uint32, GGUF_TYPE.int32] as number[]).includes(entry.arrayType ?? -1);
    case "float-array": return entry.type === GGUF_TYPE.array && ([GGUF_TYPE.float32, GGUF_TYPE.float64] as number[]).includes(entry.arrayType ?? -1);
  }
}

function metadataValueMatches(actual: MetadataEntry["value"], expected: string | number | boolean): boolean {
  if (typeof expected === "number") {
    if (typeof actual !== "number" || !Number.isFinite(actual)) return false;
    const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-7);
    return Math.abs(actual - expected) <= tolerance;
  }
  return actual === expected;
}

function qwenMetadataContractInvalidKeys(metadata: ReadonlyMap<string, MetadataEntry>): string[] {
  const invalid = new Set<string>();

  for (const [key, expected] of QWEN35MOE_EXACT_VALUES) {
    const entry = metadata.get(key);
    if (!entry) {
      if (key !== "qwen35moe.nextn_predict_layers") invalid.add(key);
      continue;
    }
    if (!metadataValueMatches(entry.value, expected)) invalid.add(key);
  }

  for (const [key, expectedLength] of QWEN35MOE_ARRAY_LENGTHS) {
    if (metadata.get(key)?.arrayLength !== expectedLength) invalid.add(key);
  }

  const ropeSections = metadata.get("qwen35moe.rope.dimension_sections")?.arrayValues;
  if (!ropeSections ||
      ropeSections.length !== QWEN35MOE_ROPE_SECTIONS.length ||
      ropeSections.some((value, index) => value !== QWEN35MOE_ROPE_SECTIONS[index])) {
    invalid.add("qwen35moe.rope.dimension_sections");
  }

  if (metadata.get("tokenizer.ggml.token_type")?.contractMatches !== true) {
    invalid.add("tokenizer.ggml.token_type");
  }

  const chatTemplate = metadata.get("tokenizer.chat_template");
  if (chatTemplate?.byteLength !== QWEN35MOE_CHAT_TEMPLATE_BYTES ||
      chatTemplate.sha256 !== QWEN35MOE_CHAT_TEMPLATE_SHA256) {
    invalid.add("tokenizer.chat_template");
  }

  const recurrentLayers = metadata.get(QWEN35MOE_RECURRENT_LAYERS_KEY);
  if (recurrentLayers &&
      (recurrentLayers.type !== GGUF_TYPE.array ||
       recurrentLayers.arrayType !== GGUF_TYPE.bool ||
       recurrentLayers.arrayLength !== 40 ||
       recurrentLayers.contractMatches !== true)) {
    invalid.add(QWEN35MOE_RECURRENT_LAYERS_KEY);
  }

  return [...invalid];
}

function glm52MetadataContractInvalidKeys(metadata: ReadonlyMap<string, MetadataEntry>): string[] {
  const invalid = new Set<string>();

  for (const [key, expected] of GLM52_EXACT_VALUES) {
    const entry = metadata.get(key);
    if (!entry || !metadataValueMatches(entry.value, expected)) invalid.add(key);
  }
  for (const [key, expectedLength] of GLM52_ARRAY_LENGTHS) {
    if (metadata.get(key)?.arrayLength !== expectedLength) invalid.add(key);
  }
  if (metadata.get("tokenizer.ggml.token_type")?.sha256 !== GLM52_TOKEN_TYPES_SHA256) {
    invalid.add("tokenizer.ggml.token_type");
  }
  const chatTemplate = metadata.get("tokenizer.chat_template");
  if (chatTemplate?.byteLength !== GLM52_CHAT_TEMPLATE_BYTES ||
      chatTemplate.sha256 !== GLM52_CHAT_TEMPLATE_SHA256) {
    invalid.add("tokenizer.chat_template");
  }

  return [...invalid];
}

function tensorLayoutMatches(descriptor: TensorDescriptor, expectation: TensorLayoutExpectation): boolean {
  return expectation.types.includes(descriptor.type) &&
    descriptor.dimensions.length === expectation.dimensions.length &&
    descriptor.dimensions.every((dimension, index) => dimension === expectation.dimensions[index]);
}

function expertMajorStoreDescriptorMatches(descriptor: TensorDescriptor | undefined): boolean {
  return Boolean(descriptor
    && descriptor.type === GGML_TYPE.i8
    && descriptor.dimensions.length === 1
    && Number.isSafeInteger(descriptor.dimensions[0])
    && descriptor.dimensions[0] > 0);
}

function result(
  header: Pick<Ds4GgufCompatibility, "ggufVersion" | "tensorCount" | "metadataCount" | "architecture" | "splitCount" | "artifactFormat">,
  reason: Ds4GgufCompatibilityReason | null
): Ds4GgufCompatibility {
  return { compatible: reason === null, ...header, reason };
}

const emptyHeader = {
  ggufVersion: null,
  tensorCount: null,
  metadataCount: null,
  architecture: null,
  splitCount: null,
  artifactFormat: null
};

/**
 * Inspect the GGUF v3 header, metadata, and tensor directory required by the
 * current DS4 runtime. Tensor payloads are not mapped; Qwen additionally reads
 * the fixed 168-byte ExpertMajor header prefix so Hebrus Studio can reject the retired
 * GGML/Q4 store before attempting to launch the affine-only runtime.
 */
export async function inspectDs4Gguf(filePath: string): Promise<Ds4GgufCompatibility> {
  let handle: FileHandle | null = null;
  const header: Pick<Ds4GgufCompatibility, "ggufVersion" | "tensorCount" | "metadataCount" | "architecture" | "splitCount" | "artifactFormat"> = { ...emptyHeader };
  try {
    handle = await open(filePath, "r");
    const file = await handle.stat();
    if (!file.isFile() || file.size < GGUF_HEADER_BYTES) {
      return result(header, { code: "invalid_gguf", message: "This file is too small to contain a GGUF model." });
    }

    const cursor = new GgufCursor(handle, file.size);
    const rawHeader = await cursor.bytes(GGUF_HEADER_BYTES);
    if (rawHeader.subarray(0, 4).toString("ascii") !== "GGUF") {
      return result(header, { code: "not_gguf", message: "This file is not a GGUF model." });
    }

    const ggufVersion = rawHeader.readUInt32LE(4);
    header.ggufVersion = ggufVersion;
    if (ggufVersion !== GGUF_VERSION) {
      return result(header, {
        code: "unsupported_gguf_version",
        message: `Hebrus requires GGUF v${GGUF_VERSION}; this file is GGUF v${ggufVersion}.`
      });
    }

    const tensorCount = safeNumber(rawHeader.readBigUInt64LE(8), "GGUF tensor count", MAX_TENSORS);
    const metadataCount = safeNumber(rawHeader.readBigUInt64LE(16), "GGUF metadata count", MAX_METADATA_ENTRIES);
    header.tensorCount = tensorCount;
    header.metadataCount = metadataCount;

    const metadata = new Map<string, MetadataEntry>();
    for (let index = 0; index < metadataCount; index += 1) {
      const remainingEntries = metadataCount - index - 1;
      const tailMinimum = minimumMetadataTail(remainingEntries, tensorCount);
      const key = await readString(cursor, MAX_KEY_BYTES, 4 + 1 + tailMinimum, true);
      if (key === null || metadata.has(key)) throw new GgufParseError("GGUF metadata keys are invalid or duplicated");
      const type = await cursor.u32(5 + tailMinimum);
      metadata.set(key, await readMetadataValue(cursor, type, key, tailMinimum));
    }

    const architectureEntry = metadata.get("general.architecture");
    header.architecture = architectureEntry?.type === GGUF_TYPE.string && typeof architectureEntry.value === "string"
      ? architectureEntry.value
      : null;
    const splitEntry = metadata.get("split.count");
    header.splitCount = typeof splitEntry?.value === "number" ? splitEntry.value : null;

    const tensors = new Map<string, TensorDescriptor>();
    for (let index = 0; index < tensorCount; index += 1) {
      const remainingTensors = tensorCount - index - 1;
      const tensorTail = remainingTensors * 24;
      const name = await readString(cursor, MAX_NAME_BYTES, 16 + tensorTail, true);
      if (name === null || tensors.has(name)) throw new GgufParseError("GGUF tensor names are invalid or duplicated");
      const dimensionCount = await cursor.u32(12 + tensorTail);
      if (dimensionCount < 1 || dimensionCount > 4) throw new GgufParseError(`GGUF tensor ${name} has an invalid dimension count`);
      const dimensions: number[] = [];
      for (let dimension = 0; dimension < dimensionCount; dimension += 1) {
        dimensions.push(safeNumber(await cursor.u64((dimensionCount - dimension - 1) * 8 + 12 + tensorTail), `GGUF tensor ${name} dimension`));
      }
      const type = await cursor.u32(8 + tensorTail);
      const offset = safeNumber(await cursor.u64(tensorTail + 8), `GGUF tensor ${name} offset`);
      tensors.set(name, { dimensions, offset, type });
    }

    const expertMajorV1Tensor = "ds4.expert_major.v1";
    const expertMajorV2Tensor = ds4ArtifactFormatTensor("ds4-expert-major-v2");
    const expertMajorV1 = tensors.get(expertMajorV1Tensor);
    const expertMajorV2 = tensors.get(expertMajorV2Tensor);
    if (expertMajorV1 && expertMajorV2) {
      return result(header, {
        code: "missing_tensor_signature",
        message: "This GGUF mixes two incompatible Hebrus ExpertMajor store versions."
      });
    }
    if (expertMajorV1) {
      return result(header, {
        code: "missing_tensor_signature",
        message: "Hebrus ExpertMajor v1 is no longer runnable. Select or convert the ExpertMajor v2 artifact."
      });
    }
    header.artifactFormat = expertMajorV2 ? "ds4-expert-major-v2" : null;
    if (expertMajorV2 && !expertMajorStoreDescriptorMatches(expertMajorV2)) {
      return result(header, {
        code: "missing_tensor_signature",
        message: `The ${header.artifactFormat} store has an invalid opaque I8 tensor descriptor.`
      });
    }

    if ((header.splitCount ?? 1) > 1) {
      return result(header, {
        code: "multipart_unsupported",
        message: "Hebrus does not support standard multi-file GGUF sets. Choose a single Hebrus ExpertMajor GGUF instead."
      });
    }
    if (tensorCount === 0) {
      return result(header, {
        code: "empty_tensor_directory",
        message: "This GGUF contains no model tensors and cannot run in Hebrus."
      });
    }
    if (!architectureEntry) {
      return result(header, {
        code: "missing_architecture",
        message: "This GGUF does not declare general.architecture, so Hebrus Studio cannot verify it for Hebrus."
      });
    }
    if (architectureEntry.type !== GGUF_TYPE.string || header.architecture === null) {
      return result(header, {
        code: "invalid_metadata_type",
        message: "The GGUF general.architecture metadata has an invalid type.",
        invalidKeys: ["general.architecture"]
      });
    }
    if (header.architecture !== "deepseek4" &&
        header.architecture !== "qwen35moe" &&
        header.architecture !== "glm-dsa") {
      return result(header, {
        code: "unsupported_architecture",
        message: `The current Hebrus runtime does not support the ${header.architecture} GGUF architecture.`
      });
    }

    if (header.artifactFormat === "ds4-expert-major-v2" &&
        header.architecture !== "deepseek4" &&
        header.architecture !== "glm-dsa" &&
        header.architecture !== "qwen35moe") {
      return result(header, {
        code: "missing_tensor_signature",
        message: "Hebrus ExpertMajor v2 requires a pinned Qwen3.6, DeepSeek 4, or GLM-5.2 layout."
      });
    }

    const isQwen35Moe = header.architecture === "qwen35moe";
    const isGlm52 = header.architecture === "glm-dsa";
    if (header.artifactFormat !== "ds4-expert-major-v2") {
      return result(header, {
        code: "missing_tensor_signature",
        message: `Hebrus Studio qualifies ${isQwen35Moe ? "Qwen3.6 35B A3B" : isGlm52 ? "GLM-5.2" : "DeepSeek 4"} only as a single-file Hebrus ExpertMajor v2 artifact.`
      });
    }
    const metadataContract = isQwen35Moe
      ? QWEN35MOE_METADATA
      : isGlm52
        ? GLM52_METADATA
        : DEEPSEEK4_METADATA;
    const modelName = isQwen35Moe ? "Qwen3.6 35B A3B" : isGlm52 ? "GLM-5.2" : "DeepSeek 4";
    const missingMetadata = [...metadataContract.keys()].filter((key) => !metadata.has(key));
    if (missingMetadata.length > 0) {
      return result(header, {
        code: "missing_metadata",
        message: `This ${modelName} GGUF is missing metadata required by Hebrus: ${missingMetadata.join(", ")}.`,
        missingKeys: missingMetadata
      });
    }
    const invalidMetadata = [...metadataContract].flatMap(([key, expectation]) => {
      const entry = metadata.get(key);
      return entry && !expectationMatches(entry, expectation) ? [key] : [];
    });
    if (invalidMetadata.length > 0) {
      return result(header, {
        code: "invalid_metadata_type",
        message: `This ${modelName} GGUF has legacy DS4 metadata with an incompatible type: ${invalidMetadata.join(", ")}.`,
        invalidKeys: invalidMetadata
      });
    }

    if (isQwen35Moe) {
      const invalidValues = qwenMetadataContractInvalidKeys(metadata);
      if (invalidValues.length > 0) {
        return result(header, {
          code: "invalid_metadata_type",
          message: `This Qwen3.6 35B A3B GGUF does not match Hebrus's pinned metadata contract: ${invalidValues.join(", ")}.`,
          invalidKeys: invalidValues
        });
      }

      const qwenTensorLayout = QWEN35MOE_NATIVE_TENSOR_LAYOUT;
      const missingTensors = [...qwenTensorLayout.keys()].filter((name) => !tensors.has(name));
      if (missingTensors.length > 0) {
        return result(header, {
          code: "missing_tensor_signature",
          message: `This GGUF does not contain the DS4 Qwen3.6 35B A3B ExpertMajor v2 tensor layout: ${missingTensors.join(", ")}.`,
          missingKeys: [...missingTensors]
        });
      }

      const invalidTensors = [...qwenTensorLayout].flatMap(([name, expectation]) => {
        const descriptor = tensors.get(name);
        return descriptor && !tensorLayoutMatches(descriptor, expectation) ? [name] : [];
      });
      if (invalidTensors.length > 0) {
        return result(header, {
          code: "missing_tensor_signature",
          message: `This Qwen GGUF is not normalized for the DS4 Qwen3.6 35B A3B tensor layout: ${invalidTensors.join(", ")}.`,
          invalidKeys: invalidTensors
        });
      }

      const qwenStore = tensors.get(expertMajorV2Tensor);
      if (qwenStore?.dimensions[0] !== DS4_QWEN35MOE_EXPERT_STORE_BYTES) {
        return result(header, {
          code: "missing_tensor_signature",
          message: "This Qwen3.6 GGUF has an incompatible ExpertMajor v2 routed-store extent.",
          invalidKeys: [expertMajorV2Tensor]
        });
      }
      const declaredAlignment = metadata.get("general.alignment")?.value;
      const dataAlignment = typeof declaredAlignment === "number"
        ? declaredAlignment
        : GGUF_DEFAULT_ALIGNMENT;
      const dataStart = alignUp(cursor.position, dataAlignment);
      const qwenStoreOffset = dataStart + (qwenStore?.offset ?? 0);
      if (!Number.isSafeInteger(qwenStoreOffset) ||
          qwenStoreOffset > file.size - EXPERT_MAJOR_V2_HEADER_PROBE_BYTES) {
        return result(header, {
          code: "missing_tensor_signature",
          message: "This Qwen3.6 GGUF has a truncated ExpertMajor v2 manifest.",
          invalidKeys: [expertMajorV2Tensor]
        });
      }
      const storeHeader = Buffer.allocUnsafe(EXPERT_MAJOR_V2_HEADER_PROBE_BYTES);
      const { bytesRead } = await handle.read(
        storeHeader, 0, storeHeader.length, qwenStoreOffset
      );
      const affineStore = bytesRead === storeHeader.length &&
        storeHeader.subarray(0, 8).toString("ascii") === EXPERT_MAJOR_V2_MAGIC &&
        storeHeader.readUInt32LE(160) === EXPERT_MAJOR_STORAGE_MLX_AFFINE4 &&
        storeHeader.readUInt32LE(164) === EXPERT_MAJOR_MLX_GROUP_SIZE;
      if (!affineStore) {
        return result(header, {
          code: "missing_tensor_signature",
          message: "Qwen3.6 now requires the ExpertMajor v2 MLX affine4/group-64 payload; the retired GGML/Q4 store is not runnable.",
          invalidKeys: [expertMajorV2Tensor]
        });
      }
      const canonicalRoutedTensors = [...tensors.keys()].filter((name) => QWEN35MOE_ROUTED_TENSOR.test(name));
      if (canonicalRoutedTensors.length > 0) {
        return result(header, {
          code: "missing_tensor_signature",
          message: "This Qwen3.6 GGUF mixes ExpertMajor v2 with canonical routed expert tensors.",
          invalidKeys: canonicalRoutedTensors.slice(0, 16)
        });
      }
      if (tensorCount !== DS4_QWEN35MOE_NATIVE_TENSOR_COUNT) {
        return result(header, {
          code: "missing_tensor_signature",
          message: `Hebrus requires the ${DS4_QWEN35MOE_NATIVE_TENSOR_COUNT}-tensor Qwen3.6 35B A3B ExpertMajor v2 layout; this GGUF contains ${tensorCount} tensors.`
        });
      }

      return result(header, null);
    }

    if (isGlm52) {
      const invalidValues = glm52MetadataContractInvalidKeys(metadata);
      if (invalidValues.length > 0) {
        return result(header, {
          code: "invalid_metadata_type",
          message: `This GLM-5.2 GGUF does not match Hebrus's pinned metadata contract: ${invalidValues.join(", ")}.`,
          invalidKeys: invalidValues
        });
      }
      const missingTensors = [...GLM52_NATIVE_TENSOR_LAYOUT.keys()].filter((name) => !tensors.has(name));
      if (missingTensors.length > 0) {
        return result(header, {
          code: "missing_tensor_signature",
          message: `This GGUF does not contain the pinned DS4 GLM-5.2 ExpertMajor v2 tensor layout: ${missingTensors.join(", ")}.`,
          missingKeys: missingTensors
        });
      }
      const invalidTensors = [...GLM52_NATIVE_TENSOR_LAYOUT].flatMap(([name, expectation]) => {
        const descriptor = tensors.get(name);
        return descriptor && !tensorLayoutMatches(descriptor, expectation) ? [name] : [];
      });
      const glmStore = tensors.get(expertMajorV2Tensor);
      if (glmStore?.dimensions[0] !== DS4_GLM52_EXPERT_STORE_BYTES) {
        invalidTensors.push(expertMajorV2Tensor);
      }
      if (invalidTensors.length > 0) {
        return result(header, {
          code: "missing_tensor_signature",
          message: `This GLM-5.2 GGUF has an incompatible ExpertMajor v2 tensor layout: ${invalidTensors.join(", ")}.`,
          invalidKeys: invalidTensors
        });
      }
      const canonicalRoutedTensors = [...tensors.keys()].filter((name) => QWEN35MOE_ROUTED_TENSOR.test(name));
      if (canonicalRoutedTensors.length > 0) {
        return result(header, {
          code: "missing_tensor_signature",
          message: "This GLM-5.2 GGUF mixes ExpertMajor v2 with canonical routed expert tensors.",
          invalidKeys: canonicalRoutedTensors.slice(0, 16)
        });
      }
      if (tensorCount !== DS4_GLM52_NATIVE_TENSOR_COUNT) {
        return result(header, {
          code: "missing_tensor_signature",
          message: `Hebrus requires the ${DS4_GLM52_NATIVE_TENSOR_COUNT}-tensor GLM-5.2 ExpertMajor v2 layout; this GGUF contains ${tensorCount} tensors.`
        });
      }
      return result(header, null);
    }

    const deepseekSignature = DS4_DEEPSEEK4_NATIVE_TENSOR_SIGNATURE;
    const missingTensors = deepseekSignature.filter((name) => !tensors.has(name));
    if (missingTensors.length > 0) {
      return result(header, {
        code: "missing_tensor_signature",
        message: `This GGUF does not contain the Hebrus-native DeepSeek 4 tensor layout: ${missingTensors.join(", ")}.`,
        missingKeys: [...missingTensors]
      });
    }

    const canonicalRoutedTensors = [...tensors.keys()].filter((name) => QWEN35MOE_ROUTED_TENSOR.test(name));
    if (canonicalRoutedTensors.length > 0) {
      return result(header, {
        code: "missing_tensor_signature",
        message: "This GGUF mixes Hebrus ExpertMajor v2 with canonical routed expert tensors.",
        invalidKeys: canonicalRoutedTensors.slice(0, 16)
      });
    }

    return result(header, null);
  } catch (error) {
    if (error instanceof GgufParseError) {
      return result(header, { code: "invalid_gguf", message: `This GGUF is corrupt or incomplete: ${error.message}.` });
    }
    const message = error instanceof Error ? error.message : String(error);
    return result(header, { code: "io_error", message: `Hebrus Studio could not read this GGUF: ${message}` });
  } finally {
    await handle?.close();
  }
}
