import { gunzipSync } from "node:zlib";

const GGUF_VERSION = 3;
const GGUF_TYPE_UINT32 = 4;
const GGUF_TYPE_INT32 = 5;
const GGUF_TYPE_FLOAT32 = 6;
const GGUF_TYPE_BOOL = 7;
const GGUF_TYPE_STRING = 8;
const GGUF_TYPE_ARRAY = 9;
const GGML_TYPE_F32 = 0;
const GGML_TYPE_Q8_0 = 8;
const GGML_TYPE_Q4_K = 12;
const GGML_TYPE_Q6_K = 14;
const GGML_TYPE_I8 = 24;

const QWEN_CHAT_TEMPLATE_GZIP_BASE64 = "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";
const QWEN_CHAT_TEMPLATE = gunzipSync(Buffer.from(QWEN_CHAT_TEMPLATE_GZIP_BASE64, "base64"));

const DS4_TENSOR_SIGNATURE = [
  "token_embd.weight",
  "output.weight",
  "output_norm.weight",
  "blk.0.attn_q_a.weight",
  "blk.0.ffn_gate_inp.weight",
  "blk.0.ffn_gate_exps.weight"
] as const;

const DS4_UINT32_METADATA = [
  "deepseek4.block_count",
  "deepseek4.embedding_length",
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
] as const;

const DS4_FLOAT32_METADATA = [
  "deepseek4.rope.freq_base",
  "deepseek4.attention.compress_rope_freq_base",
  "deepseek4.expert_weights_scale",
  "deepseek4.attention.layer_norm_rms_epsilon",
  "deepseek4.hyper_connection.epsilon"
] as const;

function uint32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function uint64(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function float32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
}

function int32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([uint64(bytes.length), bytes]);
}

function stringMetadata(key: string, value: string): Buffer {
  return Buffer.concat([
    ggufString(key),
    uint32(GGUF_TYPE_STRING),
    ggufString(value)
  ]);
}

function stringBufferMetadata(key: string, value: Buffer): Buffer {
  return Buffer.concat([
    ggufString(key),
    uint32(GGUF_TYPE_STRING),
    uint64(value.length),
    value
  ]);
}

function uint32Metadata(key: string, value: number): Buffer {
  return Buffer.concat([
    ggufString(key),
    uint32(GGUF_TYPE_UINT32),
    uint32(value)
  ]);
}

function float32Metadata(key: string, value: number): Buffer {
  return Buffer.concat([
    ggufString(key),
    uint32(GGUF_TYPE_FLOAT32),
    float32(value)
  ]);
}

function boolMetadata(key: string, value: boolean): Buffer {
  return Buffer.concat([
    ggufString(key),
    uint32(GGUF_TYPE_BOOL),
    Buffer.from([value ? 1 : 0])
  ]);
}

function arrayMetadata(key: string, itemType: number, items: Buffer[]): Buffer {
  return Buffer.concat([
    ggufString(key),
    uint32(GGUF_TYPE_ARRAY),
    uint32(itemType),
    uint64(items.length),
    ...items
  ]);
}

function repeatedEmptyStringArrayMetadata(key: string, count: number): Buffer {
  return Buffer.concat([
    ggufString(key),
    uint32(GGUF_TYPE_ARRAY),
    uint32(GGUF_TYPE_STRING),
    uint64(count),
    Buffer.alloc(count * 8)
  ]);
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

function qwenTokenTypeMetadata(): Buffer {
  const count = 248_320;
  const values = Buffer.allocUnsafe(count * 4);
  for (let token = 0; token < count; token += 1) {
    values.writeInt32LE(qwenExpectedTokenType(token), token * 4);
  }
  return Buffer.concat([
    ggufString("tokenizer.ggml.token_type"),
    uint32(GGUF_TYPE_ARRAY),
    uint32(GGUF_TYPE_INT32),
    uint64(count),
    values
  ]);
}

function shapedTensorDescriptor(name: string, type: number, dimensions: readonly number[]): Buffer {
  return Buffer.concat([
    ggufString(name),
    uint32(dimensions.length),
    ...dimensions.map(uint64),
    uint32(type),
    uint64(0)
  ]);
}

export interface Ds4GgufFixtureOptions {
  includeVocabSize?: boolean;
  nativeExpertMajorV2?: boolean;
  vocabSize?: number;
}

/**
 * Builds a small GGUF v3 header that satisfies DSBox's DS4 preflight. It has
 * the required metadata types and tensor-name signature, but no model weights.
 */
export function createDs4GgufFixture(options: Ds4GgufFixtureOptions = {}): Buffer {
  const metadata = [
    stringMetadata("general.architecture", "deepseek4"),
    ...DS4_UINT32_METADATA.map((key) => uint32Metadata(key, 1)),
    ...DS4_FLOAT32_METADATA.map((key) => float32Metadata(key, 1)),
    boolMetadata("deepseek4.expert_weights_norm", true),
    arrayMetadata("deepseek4.attention.compress_ratios", GGUF_TYPE_UINT32, [uint32(1)]),
    arrayMetadata("deepseek4.swiglu_clamp_exp", GGUF_TYPE_FLOAT32, [float32(1)]),
    arrayMetadata("tokenizer.ggml.tokens", GGUF_TYPE_STRING, [ggufString("token")]),
    arrayMetadata("tokenizer.ggml.merges", GGUF_TYPE_STRING, [ggufString("t oken")])
  ];
  if (options.includeVocabSize !== false) {
    metadata.push(uint32Metadata("deepseek4.vocab_size", options.vocabSize ?? 129_280));
  }

  const tensors = options.nativeExpertMajorV2
    ? [
        ...DS4_TENSOR_SIGNATURE.filter((name) => name !== "blk.0.ffn_gate_exps.weight").map((name) => ({ name, type: GGML_TYPE_F32, dimensions: [1] })),
        { name: "ds4.expert_major.v2", type: GGML_TYPE_I8, dimensions: [4096] }
      ]
    : DS4_TENSOR_SIGNATURE.map((name) => ({ name, type: GGML_TYPE_F32, dimensions: [1] }));

  return Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    uint32(GGUF_VERSION),
    uint64(tensors.length),
    uint64(metadata.length),
    ...metadata,
    ...tensors.map((tensor) => shapedTensorDescriptor(tensor.name, tensor.type, tensor.dimensions))
  ]);
}

interface QwenTensorFixture {
  dimensions: readonly number[];
  name: string;
  type: number;
}

function createQwen35MoeTensorLayout(): QwenTensorFixture[] {
  const tensors: QwenTensorFixture[] = [];
  const add = (name: string, type: number, ...dimensions: number[]) => {
    tensors.push({ dimensions, name, type });
  };

  add("token_embd.weight", GGML_TYPE_Q8_0, 2048, 248_320);
  add("output_norm.weight", GGML_TYPE_F32, 2048);
  add("output.weight", GGML_TYPE_Q8_0, 2048, 248_320);

  for (let layer = 0; layer < 40; layer += 1) {
    const prefix = `blk.${layer}`;
    add(`${prefix}.attn_norm.weight`, GGML_TYPE_F32, 2048);
    add(`${prefix}.post_attention_norm.weight`, GGML_TYPE_F32, 2048);

    if ((layer + 1) % 4 === 0) {
      add(`${prefix}.attn_q.weight`, GGML_TYPE_Q8_0, 2048, 8192);
      add(`${prefix}.attn_k.weight`, GGML_TYPE_Q8_0, 2048, 512);
      add(`${prefix}.attn_v.weight`, GGML_TYPE_Q8_0, 2048, 512);
      add(`${prefix}.attn_output.weight`, GGML_TYPE_Q8_0, 4096, 2048);
      add(`${prefix}.attn_q_norm.weight`, GGML_TYPE_F32, 256);
      add(`${prefix}.attn_k_norm.weight`, GGML_TYPE_F32, 256);
    } else {
      add(`${prefix}.attn_gate.weight`, GGML_TYPE_Q8_0, 2048, 4096);
      add(`${prefix}.attn_qkv.weight`, GGML_TYPE_Q8_0, 2048, 8192);
      add(`${prefix}.ssm_a`, GGML_TYPE_F32, 32);
      add(`${prefix}.ssm_alpha.weight`, GGML_TYPE_F32, 2048, 32);
      add(`${prefix}.ssm_beta.weight`, GGML_TYPE_F32, 2048, 32);
      add(`${prefix}.ssm_conv1d.weight`, GGML_TYPE_F32, 4, 8192);
      add(`${prefix}.ssm_dt.bias`, GGML_TYPE_F32, 32);
      add(`${prefix}.ssm_norm.weight`, GGML_TYPE_F32, 128);
      add(`${prefix}.ssm_out.weight`, GGML_TYPE_Q8_0, 4096, 2048);
    }

    add(`${prefix}.ffn_gate_inp.weight`, GGML_TYPE_F32, 2048, 256);
    add(`${prefix}.ffn_gate_exps.weight`, GGML_TYPE_Q4_K, 2048, 512, 256);
    add(`${prefix}.ffn_up_exps.weight`, GGML_TYPE_Q4_K, 2048, 512, 256);
    add(`${prefix}.ffn_down_exps.weight`, GGML_TYPE_Q4_K, 512, 2048, 256);
    add(`${prefix}.ffn_gate_inp_shexp.weight`, GGML_TYPE_F32, 2048);
    add(`${prefix}.ffn_gate_shexp.weight`, GGML_TYPE_Q8_0, 2048, 512);
    add(`${prefix}.ffn_up_shexp.weight`, GGML_TYPE_Q8_0, 2048, 512);
    add(`${prefix}.ffn_down_shexp.weight`, GGML_TYPE_Q8_0, 512, 2048);
  }

  return tensors;
}

export interface Ds4QwenGgufFixtureOptions {
  invalidChatTemplate?: boolean;
  paddingTokenId?: number;
  /** Recreates the original Unsloth artifact's unsupported output quant. */
  rawUnslothLayout?: boolean;
  nativeExpertMajorV1?: boolean;
}

/**
 * Builds a header-only fixture for DS4's normalized Qwen3.6 35B A3B
 * `qwen35moe` contract. The production runtime still performs value, payload,
 * and chat-template validation when it opens a real model.
 */
export function createDs4QwenGgufFixture(options: Ds4QwenGgufFixtureOptions = {}): Buffer {
  const chatTemplate = Buffer.from(QWEN_CHAT_TEMPLATE);
  if (options.invalidChatTemplate) chatTemplate[0] ^= 1;
  const metadata = [
    stringMetadata("general.architecture", "qwen35moe"),
    uint32Metadata("qwen35moe.block_count", 40),
    uint32Metadata("qwen35moe.context_length", 262_144),
    uint32Metadata("qwen35moe.embedding_length", 2048),
    uint32Metadata("qwen35moe.attention.head_count", 16),
    uint32Metadata("qwen35moe.attention.head_count_kv", 2),
    uint32Metadata("qwen35moe.attention.key_length", 256),
    uint32Metadata("qwen35moe.attention.value_length", 256),
    uint32Metadata("qwen35moe.rope.dimension_count", 64),
    arrayMetadata("qwen35moe.rope.dimension_sections", GGUF_TYPE_INT32, [11, 11, 10, 0].map(int32)),
    float32Metadata("qwen35moe.rope.freq_base", 10_000_000),
    float32Metadata("qwen35moe.attention.layer_norm_rms_epsilon", 1e-6),
    uint32Metadata("qwen35moe.expert_count", 256),
    uint32Metadata("qwen35moe.expert_used_count", 8),
    uint32Metadata("qwen35moe.expert_feed_forward_length", 512),
    uint32Metadata("qwen35moe.expert_shared_feed_forward_length", 512),
    uint32Metadata("qwen35moe.ssm.conv_kernel", 4),
    uint32Metadata("qwen35moe.ssm.state_size", 128),
    uint32Metadata("qwen35moe.ssm.group_count", 16),
    uint32Metadata("qwen35moe.ssm.time_step_rank", 32),
    uint32Metadata("qwen35moe.ssm.inner_size", 4096),
    uint32Metadata("qwen35moe.full_attention_interval", 4),
    stringMetadata("tokenizer.ggml.model", "gpt2"),
    stringMetadata("tokenizer.ggml.pre", "qwen35"),
    repeatedEmptyStringArrayMetadata("tokenizer.ggml.tokens", 248_320),
    qwenTokenTypeMetadata(),
    repeatedEmptyStringArrayMetadata("tokenizer.ggml.merges", 247_587),
    uint32Metadata("tokenizer.ggml.bos_token_id", 248_044),
    uint32Metadata("tokenizer.ggml.padding_token_id", options.paddingTokenId ?? 248_044),
    uint32Metadata("tokenizer.ggml.eos_token_id", 248_046),
    boolMetadata("tokenizer.ggml.add_bos_token", false),
    stringBufferMetadata("tokenizer.chat_template", chatTemplate)
  ];
  const tensors = createQwen35MoeTensorLayout();
  if (options.rawUnslothLayout) {
    for (const tensor of tensors) {
      if (tensor.name === "output.weight" ||
          ["blk.34.ffn_down_exps.weight", "blk.38.ffn_down_exps.weight", "blk.39.ffn_down_exps.weight"].includes(tensor.name)) {
        tensor.type = GGML_TYPE_Q6_K;
      }
    }
  }
  if (options.nativeExpertMajorV1) {
    const canonical = tensors.filter((tensor) => !/^blk\.\d+\.ffn_(?:gate|up|down)_exps\.weight$/.test(tensor.name));
    tensors.splice(0, tensors.length, ...canonical, {
      name: "ds4.expert_major.v1",
      type: GGML_TYPE_I8,
      dimensions: [4096]
    });
  }

  return Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    uint32(GGUF_VERSION),
    uint64(tensors.length),
    uint64(metadata.length),
    ...metadata,
    ...tensors.map((tensor) => shapedTensorDescriptor(tensor.name, tensor.type, tensor.dimensions))
  ]);
}
