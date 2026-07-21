const MEDIA_PART_TYPES = new Set([
  "audio",
  "document",
  "file",
  "image",
  "image_url",
  "input_audio",
  "input_file",
  "input_image",
  "input_video",
  "video",
  "video_url"
]);

const MEDIA_KEYS = new Set([
  "audio",
  "audio_url",
  "file",
  "file_data",
  "file_id",
  "image",
  "image_url",
  "video",
  "video_url"
]);

export interface UnsupportedModalityDetails {
  modality: "audio" | "file" | "image" | "video";
  location: string;
}

export class UnsupportedInputModalityError extends Error {
  readonly code = "unsupported_input_modality";
  readonly status = 422;
  readonly details: UnsupportedModalityDetails;

  constructor(details: UnsupportedModalityDetails) {
    const label = details.modality === "file" ? "file input" : `${details.modality} input`;
    super(`This Hebrus Studio runtime accepts text only; ${label} is not supported.`);
    this.name = "UnsupportedInputModalityError";
    this.details = details;
  }
}

function modalityFor(value: string): UnsupportedModalityDetails["modality"] {
  if (value.includes("audio")) return "audio";
  if (value.includes("video")) return "video";
  if (value.includes("image")) return "image";
  return "file";
}

function inspectContent(value: unknown, location: string): void {
  if (!Array.isArray(value)) return;

  value.forEach((part, index) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (MEDIA_PART_TYPES.has(type)) {
      throw new UnsupportedInputModalityError({
        modality: modalityFor(type),
        location: `${location}[${index}]`
      });
    }
    for (const key of MEDIA_KEYS) {
      if (key in record) {
        throw new UnsupportedInputModalityError({
          modality: modalityFor(key),
          location: `${location}[${index}].${key}`
        });
      }
    }
  });
}

/**
 * DS4 is a text-only runtime. Validate the request shapes accepted by the
 * OpenAI Chat/Responses and Anthropic Messages gateways before proxying them,
 * so media blocks can never be silently discarded by the downstream parser.
 */
export function assertTextOnlyInput(body: unknown): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const root = body as Record<string, unknown>;

  if (Array.isArray(root.messages)) {
    root.messages.forEach((message, index) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      inspectContent((message as Record<string, unknown>).content, `messages[${index}].content`);
    });
  }

  if (Array.isArray(root.input)) {
    root.input.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      const record = item as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
      if (MEDIA_PART_TYPES.has(type)) {
        throw new UnsupportedInputModalityError({
          modality: modalityFor(type),
          location: `input[${index}]`
        });
      }
      inspectContent(record.content, `input[${index}].content`);
    });
  }
}
