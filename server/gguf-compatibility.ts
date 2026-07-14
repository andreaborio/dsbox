import { open, type FileHandle } from "node:fs/promises";

const GGUF_HEADER_BYTES = 24;
const GGUF_VERSION = 3;
const MAX_METADATA_ENTRIES = 100_000;
const MAX_TENSORS = 1_000_000;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_NAME_BYTES = 1024 * 1024;
const MAX_ARRAY_ITEMS = 5_000_000;
const READ_BUFFER_BYTES = 64 * 1024;

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

type MetadataExpectation = "u32" | "f32" | "bool" | "string-array" | "int-array" | "float-array";

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

export const DS4_DEEPSEEK4_TENSOR_SIGNATURE = [
  "token_embd.weight",
  "output.weight",
  "output_norm.weight",
  "blk.0.attn_q_a.weight",
  "blk.0.ffn_gate_inp.weight",
  "blk.0.ffn_gate_exps.weight"
] as const;

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
  reason: Ds4GgufCompatibilityReason | null;
}

interface MetadataEntry {
  type: number;
  arrayType: number | null;
  value: string | number | null;
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

async function readString(cursor: GgufCursor, maximum: number, safeTail: number, capture: boolean): Promise<string | null> {
  const length = safeNumber(await cursor.u64(8 + safeTail), "GGUF string", maximum);
  if (!capture) {
    cursor.skip(length);
    return null;
  }
  return (await cursor.bytes(length, length + safeTail)).toString("utf8");
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

function minimumMetadataTail(remainingEntries: number, tensorCount: number): number {
  return remainingEntries * 13 + tensorCount * 24;
}

async function readMetadataValue(
  cursor: GgufCursor,
  type: number,
  key: string,
  tailMinimum: number
): Promise<MetadataEntry> {
  if (type === GGUF_TYPE.string) {
    return {
      type,
      arrayType: null,
      value: await readString(cursor, MAX_NAME_BYTES, tailMinimum, key === "general.architecture")
    };
  }
  if (type === GGUF_TYPE.array) {
    const arrayType = await cursor.u32(12 + tailMinimum);
    if (arrayType === GGUF_TYPE.array) throw new GgufParseError("Nested GGUF metadata arrays are not supported");
    const count = safeNumber(await cursor.u64(8 + tailMinimum), "GGUF metadata array", MAX_ARRAY_ITEMS);
    if (arrayType === GGUF_TYPE.string) {
      for (let index = 0; index < count; index += 1) {
        const remainingStrings = count - index - 1;
        const stringTail = remainingStrings * 8 + tailMinimum;
        await readString(cursor, MAX_NAME_BYTES, stringTail, false);
      }
    } else {
      cursor.skip(count * fixedValueBytes(arrayType));
    }
    return { type, arrayType, value: null };
  }
  if (key === "split.count") {
    return { type, arrayType: null, value: await readInteger(cursor, type, tailMinimum) };
  }
  cursor.skip(fixedValueBytes(type));
  return { type, arrayType: null, value: null };
}

function expectationMatches(entry: MetadataEntry, expectation: MetadataExpectation): boolean {
  switch (expectation) {
    case "u32": return entry.type === GGUF_TYPE.uint32;
    case "f32": return ([GGUF_TYPE.float32, GGUF_TYPE.float64, GGUF_TYPE.uint32, GGUF_TYPE.int32] as number[]).includes(entry.type);
    case "bool": return entry.type === GGUF_TYPE.bool;
    case "string-array": return entry.type === GGUF_TYPE.array && entry.arrayType === GGUF_TYPE.string;
    case "int-array": return entry.type === GGUF_TYPE.array && ([GGUF_TYPE.uint32, GGUF_TYPE.int32] as number[]).includes(entry.arrayType ?? -1);
    case "float-array": return entry.type === GGUF_TYPE.array && ([GGUF_TYPE.float32, GGUF_TYPE.float64] as number[]).includes(entry.arrayType ?? -1);
  }
}

function result(
  header: Pick<Ds4GgufCompatibility, "ggufVersion" | "tensorCount" | "metadataCount" | "architecture" | "splitCount">,
  reason: Ds4GgufCompatibilityReason | null
): Ds4GgufCompatibility {
  return { compatible: reason === null, ...header, reason };
}

const emptyHeader = {
  ggufVersion: null,
  tensorCount: null,
  metadataCount: null,
  architecture: null,
  splitCount: null
};

/**
 * Inspect the GGUF v3 header, metadata, and tensor directory required by the
 * current DS4 runtime. Tensor offsets are parsed, but model tensor bytes are
 * never read or mapped.
 */
export async function inspectDs4Gguf(filePath: string): Promise<Ds4GgufCompatibility> {
  let handle: FileHandle | null = null;
  const header: Pick<Ds4GgufCompatibility, "ggufVersion" | "tensorCount" | "metadataCount" | "architecture" | "splitCount"> = { ...emptyHeader };
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
        message: `DS4 requires GGUF v${GGUF_VERSION}; this file is GGUF v${ggufVersion}.`
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

    const tensorNames = new Set<string>();
    for (let index = 0; index < tensorCount; index += 1) {
      const remainingTensors = tensorCount - index - 1;
      const tensorTail = remainingTensors * 24;
      const name = await readString(cursor, MAX_NAME_BYTES, 16 + tensorTail, true);
      if (name === null || tensorNames.has(name)) throw new GgufParseError("GGUF tensor names are invalid or duplicated");
      const dimensions = await cursor.u32(12 + tensorTail);
      if (dimensions < 1 || dimensions > 4) throw new GgufParseError(`GGUF tensor ${name} has an invalid dimension count`);
      cursor.skip(dimensions * 8);
      await cursor.u32(8 + tensorTail);
      await cursor.u64(tensorTail + 8);
      tensorNames.add(name);
    }

    if ((header.splitCount ?? 1) > 1) {
      return result(header, {
        code: "multipart_unsupported",
        message: "DS4 does not support standard multi-file GGUF sets. Choose a single DS4-native GGUF instead."
      });
    }
    if (tensorCount === 0) {
      return result(header, {
        code: "empty_tensor_directory",
        message: "This GGUF contains no model tensors and cannot run in DS4."
      });
    }
    if (!architectureEntry) {
      return result(header, {
        code: "missing_architecture",
        message: "This GGUF does not declare general.architecture, so DSBox cannot verify it for DS4."
      });
    }
    if (architectureEntry.type !== GGUF_TYPE.string || header.architecture === null) {
      return result(header, {
        code: "invalid_metadata_type",
        message: "The GGUF general.architecture metadata has an invalid type.",
        invalidKeys: ["general.architecture"]
      });
    }
    if (header.architecture !== "deepseek4") {
      return result(header, {
        code: "unsupported_architecture",
        message: `The current DS4 runtime does not support the ${header.architecture} GGUF architecture.`
      });
    }

    const missingMetadata = [...DEEPSEEK4_METADATA.keys()].filter((key) => !metadata.has(key));
    if (missingMetadata.length > 0) {
      return result(header, {
        code: "missing_metadata",
        message: `This DeepSeek 4 GGUF is missing metadata required by DS4: ${missingMetadata.join(", ")}.`,
        missingKeys: missingMetadata
      });
    }
    const invalidMetadata = [...DEEPSEEK4_METADATA].flatMap(([key, expectation]) => {
      const entry = metadata.get(key);
      return entry && !expectationMatches(entry, expectation) ? [key] : [];
    });
    if (invalidMetadata.length > 0) {
      return result(header, {
        code: "invalid_metadata_type",
        message: `This DeepSeek 4 GGUF has DS4 metadata with an incompatible type: ${invalidMetadata.join(", ")}.`,
        invalidKeys: invalidMetadata
      });
    }

    const missingTensors = DS4_DEEPSEEK4_TENSOR_SIGNATURE.filter((name) => !tensorNames.has(name));
    if (missingTensors.length > 0) {
      return result(header, {
        code: "missing_tensor_signature",
        message: `This GGUF does not contain the DS4-native DeepSeek 4 tensor layout: ${missingTensors.join(", ")}.`,
        missingKeys: [...missingTensors]
      });
    }

    return result(header, null);
  } catch (error) {
    if (error instanceof GgufParseError) {
      return result(header, { code: "invalid_gguf", message: `This GGUF is corrupt or incomplete: ${error.message}.` });
    }
    const message = error instanceof Error ? error.message : String(error);
    return result(header, { code: "io_error", message: `DSBox could not read this GGUF: ${message}` });
  } finally {
    await handle?.close();
  }
}
