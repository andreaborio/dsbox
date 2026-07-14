const GGUF_VERSION = 3;
const GGUF_TYPE_UINT32 = 4;
const GGUF_TYPE_FLOAT32 = 6;
const GGUF_TYPE_BOOL = 7;
const GGUF_TYPE_STRING = 8;
const GGUF_TYPE_ARRAY = 9;
const GGML_TYPE_F32 = 0;

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

function tensorDescriptor(name: string): Buffer {
  return Buffer.concat([
    ggufString(name),
    uint32(1),
    uint64(1),
    uint32(GGML_TYPE_F32),
    uint64(0)
  ]);
}

export interface Ds4GgufFixtureOptions {
  includeVocabSize?: boolean;
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

  return Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    uint32(GGUF_VERSION),
    uint64(DS4_TENSOR_SIGNATURE.length),
    uint64(metadata.length),
    ...metadata,
    ...DS4_TENSOR_SIGNATURE.map(tensorDescriptor)
  ]);
}
