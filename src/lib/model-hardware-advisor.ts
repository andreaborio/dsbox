import type { CatalogModel, LocalModelCandidate, SystemInfo } from "../types.js";

export type ModelCompatibilityStatus = "verified" | "unverified";
export type ModelPerformanceLevel = "best" | "ssd-streaming" | "may-be-slow" | "very-slow" | "unknown";
export type ModelArchitecture = "moe" | "dense" | "unknown";

export interface ModelHardwareAssessment {
  compatibility: {
    status: ModelCompatibilityStatus;
    label: "Verified for DS4" | "Unverified";
    explanation: string;
  };
  performance: {
    level: ModelPerformanceLevel;
    label: "Best for this Mac" | "SSD streaming" | "May be slow" | "Very slow likely" | "Performance unknown";
    explanation: string;
    modelToMemoryRatio: number | null;
  };
  architecture: {
    kind: ModelArchitecture;
    source: "catalog" | "name-hint" | "unknown";
    explanation: string;
  };
  storage: {
    status: "enough" | "insufficient" | "unknown";
    requiredBytes: number;
    freeBytes: number | null;
  };
  requiresAcknowledgement: boolean;
}

export interface ModelHardwareContext extends Pick<SystemInfo, "totalMemoryBytes"> {
  diskFreeBytes?: number | null;
}

const GIB = 1024 ** 3;
const VALID_COMMIT = /^[a-f0-9]{40,64}$/i;
const VALID_SHA256 = /^[a-f0-9]{64}$/i;

function localArchitectureKind(architecture: string | null | undefined): ModelArchitecture {
  const normalized = architecture?.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "deepseek4" || normalized.includes("moe")) return "moe";
  if (/^(?:qwen|llama|mistral|gemma|phi)/.test(normalized) || normalized.includes("dense")) return "dense";
  return "unknown";
}

function detectArchitecture(model: CatalogModel): ModelHardwareAssessment["architecture"] {
  if (model.architecture === "moe" || model.architecture === "dense") {
    return {
      kind: model.architecture,
      source: "catalog",
      explanation: model.architecture === "moe"
        ? "The catalog identifies a mixture-of-experts architecture. Active expert access can affect streaming performance."
        : "The catalog identifies a dense architecture, which generally needs broader weight access for each token."
    };
  }

  const identity = `${model.modelId} ${model.repository} ${model.label}`.toLowerCase();
  if (/\b(?:moe|mixture[- _]of[- _]experts)\b/.test(identity)) {
    return {
      kind: "moe",
      source: "name-hint",
      explanation: "The model name suggests a mixture-of-experts architecture, but the catalog does not verify it."
    };
  }
  if (/\bdense\b/.test(identity)) {
    return {
      kind: "dense",
      source: "name-hint",
      explanation: "The model name suggests a dense architecture, but the catalog does not verify it."
    };
  }
  return {
    kind: "unknown",
    source: "unknown",
    explanation: "The catalog does not declare whether this model is dense or mixture-of-experts, so the estimate is deliberately cautious."
  };
}

function compatibility(model: CatalogModel): ModelHardwareAssessment["compatibility"] {
  const runtimePinned = Boolean(model.runtimeBranch && model.runtimeCommit && VALID_COMMIT.test(model.runtimeCommit));
  const filesVerified = model.files.length > 0 && model.files.every((file) => VALID_SHA256.test(file.sha256 ?? ""));
  if (model.installable && model.outputFile && runtimePinned && filesVerified) {
    return {
      status: "verified",
      label: "Verified for DS4",
      explanation: "The model, engine revision, and published file checksum are pinned by the DSBox catalog."
    };
  }
  return {
    status: "unverified",
    label: "Unverified",
    explanation: "DSBox does not have a complete pinned compatibility declaration for this model. It may still work with DS4."
  };
}

function performance(
  model: CatalogModel,
  totalMemoryBytes: number,
  architecture: ModelHardwareAssessment["architecture"]
): ModelHardwareAssessment["performance"] {
  if (!(model.totalBytes > 0) || !(totalMemoryBytes > 0)) {
    return {
      level: "unknown",
      label: "Performance unknown",
      explanation: "DSBox needs both the model size and this Mac's unified memory to estimate SSD-streaming pressure.",
      modelToMemoryRatio: null
    };
  }

  const ratio = model.totalBytes / totalMemoryBytes;
  const declaredMinimumBytes = (model.minimumMemoryGb ?? 0) * GIB;
  const belowPublishedGuidance = declaredMinimumBytes > totalMemoryBytes;
  const architectureUncertain = architecture.source !== "catalog";

  let level: ModelPerformanceLevel;
  if (model.recommended && !belowPublishedGuidance && ratio <= 1.5) {
    level = "best";
  } else if (architecture.kind === "dense") {
    level = ratio > 2.25 ? "very-slow" : ratio > 1.35 || belowPublishedGuidance ? "may-be-slow" : "ssd-streaming";
  } else if (architecture.kind === "moe") {
    level = ratio > 4 ? "very-slow" : ratio > 2 || belowPublishedGuidance ? "may-be-slow" : "ssd-streaming";
  } else {
    level = ratio > 3 ? "very-slow" : ratio > 1.5 || belowPublishedGuidance ? "may-be-slow" : "ssd-streaming";
  }

  const ratioText = `${ratio.toFixed(ratio >= 10 ? 0 : 1)}×`;
  const guidance = belowPublishedGuidance
    ? ` The publisher's guidance is ${model.minimumMemoryGb} GB, but this is a performance warning—not an install limit.`
    : "";
  const uncertainty = architectureUncertain
    ? " Actual speed also depends on the architecture, quantization, context, and SSD behavior."
    : " Actual speed also depends on the quantization, context, and SSD behavior.";

  if (level === "best") {
    return {
      level,
      label: "Best for this Mac",
      explanation: `DSBox recommends this model for the detected hardware. It is ${ratioText} the size of unified memory and remains eligible for SSD streaming.${uncertainty}`,
      modelToMemoryRatio: ratio
    };
  }
  if (level === "very-slow") {
    return {
      level,
      label: "Very slow likely",
      explanation: `The model is ${ratioText} the size of this Mac's unified memory. DS4 can stream weights from SSD, but generation and system responsiveness may be very slow.${guidance}${uncertainty}`,
      modelToMemoryRatio: ratio
    };
  }
  if (level === "may-be-slow") {
    return {
      level,
      label: "May be slow",
      explanation: `The model is ${ratioText} the size of this Mac's unified memory. DS4 can use SSD streaming, but performance may vary substantially.${guidance}${uncertainty}`,
      modelToMemoryRatio: ratio
    };
  }
  return {
    level: "ssd-streaming",
    label: "SSD streaming",
    explanation: ratio > 1
      ? `The model is ${ratioText} the size of unified memory. DS4 can run it by streaming weights from SSD instead of requiring the whole model in RAM.${uncertainty}`
      : `The model is ${ratioText} the size of unified memory. DS4 still uses its SSD-streaming path, with expected performance depending on the workload.${uncertainty}`,
    modelToMemoryRatio: ratio
  };
}

export function assessModelHardware(
  model: CatalogModel,
  hardware: ModelHardwareContext
): ModelHardwareAssessment {
  const architecture = detectArchitecture(model);
  const modelCompatibility = compatibility(model);
  const modelPerformance = performance(model, hardware.totalMemoryBytes, architecture);
  const freeBytes = hardware.diskFreeBytes && hardware.diskFreeBytes > 0 ? hardware.diskFreeBytes : null;
  const storageStatus = freeBytes === null
    ? "unknown"
    : model.totalBytes > 0 && model.totalBytes <= freeBytes
      ? "enough"
      : "insufficient";

  return {
    compatibility: modelCompatibility,
    performance: modelPerformance,
    architecture,
    storage: {
      status: storageStatus,
      requiredBytes: Math.max(0, model.totalBytes),
      freeBytes
    },
    requiresAcknowledgement: modelCompatibility.status === "unverified"
      || modelPerformance.level === "may-be-slow"
      || modelPerformance.level === "very-slow"
  };
}

/** Local files reach this surface only after the runtime-level GGUF preflight. */
export function assessLocalModelHardware(
  model: Pick<LocalModelCandidate, "name" | "modelId" | "sizeBytes"> &
    Partial<Pick<LocalModelCandidate, "compatibility" | "architecture">>,
  hardware: ModelHardwareContext
): ModelHardwareAssessment {
  const projectedCatalogModel: CatalogModel = {
    publisher: "andreaborio",
    repository: model.name,
    revision: "local",
    label: model.name,
    description: "Local GGUF",
    modelId: model.modelId,
    runtimeBranch: null,
    runtimeCommit: null,
    files: [{ name: model.name, sizeBytes: model.sizeBytes, sha256: null }],
    outputFile: model.name,
    totalBytes: model.sizeBytes,
    recommended: false,
    experimental: false,
    installable: false,
    minimumMemoryGb: null,
    lastModified: null,
    sourceUrl: "",
    unavailableReason: null,
    variantCount: 1,
    variants: [],
    architecture: localArchitectureKind(model.architecture)
  };
  const assessment = assessModelHardware(projectedCatalogModel, hardware);
  if (model.compatibility?.status === "compatible") {
    assessment.compatibility = {
      status: "verified",
      label: "Verified for DS4",
      explanation: "DSBox verified the GGUF v3 architecture metadata and tensor layout before adding this local model."
    };
    assessment.requiresAcknowledgement = assessment.performance.level === "may-be-slow"
      || assessment.performance.level === "very-slow";
  }
  return assessment;
}
