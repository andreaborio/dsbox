export type ModelIdentity = "deepseek" | "qwen" | "glm" | "generic";

const IDENTITY_PATTERNS: Array<{ identity: Exclude<ModelIdentity, "generic">; pattern: RegExp }> = [
  { identity: "deepseek", pattern: /(?:^|[^a-z0-9])deep[\s._-]*seek(?:[^a-z0-9]|$)/i },
  { identity: "qwen", pattern: /(?:^|[^a-z0-9])qwen(?=\d|[^a-z0-9]|$)/i },
  { identity: "glm", pattern: /(?:^|[^a-z0-9])glm(?:[^a-z0-9]|$)/i }
];

/** Resolve a known model family from catalog metadata or a local GGUF filename. */
export function identifyModel(...signals: Array<string | null | undefined>): ModelIdentity {
  const identity = signals.filter((signal): signal is string => Boolean(signal?.trim())).join(" ");
  return IDENTITY_PATTERNS.find(({ pattern }) => pattern.test(identity))?.identity ?? "generic";
}
