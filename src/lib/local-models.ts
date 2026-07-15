import type {
  LocalModelCandidate,
  LocalModelCompatibility,
  LocalModelCompatibilityCode,
  LocalModelScanSnapshot
} from "../types.js";

const LEGACY_COMPATIBILITY: LocalModelCompatibility = {
  status: "unverified",
  code: "legacy_unverified",
  reason: "This model was reported by an older DSBox service and has not passed the current compatibility check."
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCompatibility(value: unknown): LocalModelCompatibility {
  if (!isRecord(value) || !["compatible", "unsupported", "unverified"].includes(String(value.status))) {
    return { ...LEGACY_COMPATIBILITY };
  }
  const status = value.status as LocalModelCompatibility["status"];
  const fallbackCode: LocalModelCompatibilityCode = status === "compatible" ? "ds4_native" : "legacy_unverified";
  return {
    status,
    code: typeof value.code === "string" ? value.code as LocalModelCompatibilityCode : fallbackCode,
    reason: typeof value.reason === "string" ? value.reason : null
  };
}

/**
 * The UI can briefly talk to an older control plane when a source checkout or
 * desktop app is updated while DSBox is already running. Normalize that older
 * response at the API boundary instead of letting individual views assume the
 * newest candidate shape.
 */
export function normalizeLocalModelCandidate(value: unknown): LocalModelCandidate | null {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path.trim()) return null;
  const filename = value.path.split("/").at(-1)?.replace(/\.gguf$/i, "") || "Local model";
  const name = typeof value.name === "string" && value.name.trim() ? value.name : filename;
  const sizeBytes = typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
    ? Math.max(0, value.sizeBytes)
    : 0;
  return {
    path: value.path,
    name,
    sizeBytes,
    modelId: typeof value.modelId === "string" && value.modelId.trim() ? value.modelId : name,
    selected: value.selected === true,
    compatibility: normalizeCompatibility(value.compatibility),
    architecture: typeof value.architecture === "string" ? value.architecture : null
  };
}

export function normalizeLocalModelCandidates(value: unknown): LocalModelCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeLocalModelCandidate)
    .filter((candidate): candidate is LocalModelCandidate => candidate !== null);
}

export function normalizeLocalModelScanSnapshot(value: unknown): LocalModelScanSnapshot {
  if (!isRecord(value)) throw new Error("DSBox returned an invalid local model scan response");
  return {
    ...(value as unknown as LocalModelScanSnapshot),
    models: normalizeLocalModelCandidates(value.models)
  };
}

export function localModelIsRunnable(model: LocalModelCandidate): boolean {
  return model.compatibility.status !== "unsupported";
}
