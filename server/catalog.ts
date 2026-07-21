import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CatalogModel,
  CatalogModelFile,
  CatalogModelVariant,
  CatalogPublisher,
  CatalogResponse,
  CatalogSource,
  Ds4ArtifactFormat
} from "../src/types.js";
import {
  ds4ArtifactFormatTensor,
  EXPERT_MAJOR_MINIMUM_MEMORY_GB,
  QWEN35_EXPERT_MAJOR_MINIMUM_MEMORY_GB
} from "../src/lib/model-format.js";

const AUTHOR = "andreaborio" as const;
const CACHE_TTL_MS = 5 * 60 * 1000;
const HIDDEN_REPOSITORIES = new Set([
  "andreaborio/DeepSeek-V4-Flash-DS4-ExpertMajor-v2-GGUF",
  "andreaborio/GLM-5.2-DS4-ExpertMajor-v2-GGUF",
  "andreaborio/glm52-ds4-native-64g-q2k-experimental",
  "andreaborio/Qwen3.6-35B-A3B-DS4-ExpertMajor-v1-GGUF",
  "andreaborio/Qwen3.6-35B-A3B-DS4-ExpertMajor-v2-GGUF"
]);
const SUPPORTED_EXPERT_MAJOR_MODEL_IDS = new Set([
  "deepseek-v4-flash",
  "glm-5.2",
  "qwen3.6-35b-a3b"
]);

interface CatalogSourceDefinition extends CatalogSource {
  filter?: string;
  repositories?: string[];
}

const SOURCE_DEFINITIONS: CatalogSourceDefinition[] = [
  {
    id: "andreaborio",
    label: "DSBox",
    url: "https://huggingface.co/andreaborio/models",
    filter: "ds4"
  },
  {
    id: "unsloth",
    label: "Unsloth",
    url: "https://huggingface.co/unsloth/models",
    repositories: [
      "unsloth/DeepSeek-V4-Flash-GGUF",
      "unsloth/GLM-5.2-GGUF",
      "unsloth/Qwen3.6-35B-A3B-GGUF"
    ]
  },
];

const CATALOG_SOURCES: CatalogSource[] = SOURCE_DEFINITIONS.map(({ id, label, url }) => ({ id, label, url }));

interface HubSibling {
  rfilename?: string;
  size?: number;
  lfs?: { size?: number; sha256?: string } | null;
}

interface HubModel {
  id?: string;
  sha?: string;
  lastModified?: string;
  tags?: string[];
  siblings?: HubSibling[];
  architecture?: CatalogModel["architecture"];
}

interface DsboxManifest {
  schemaVersion?: number;
  name?: string;
  description?: string;
  modelId?: string;
  runtimeBranch?: string;
  runtimeCommit?: string;
  file?: string;
  recommended?: boolean;
  minimumMemoryGb?: number;
  status?: string;
  runtime?: { branch?: string };
  launch?: { servedModelId?: string };
  requirements?: { minUnifiedMemoryBytes?: number };
  architecture?: CatalogModel["architecture"];
  previousRepositories?: string[];
  artifact?: {
    output?: string;
    sizeBytes?: number;
    sha256?: string;
    assembly?: { type?: string; parts?: Array<{ path?: string; sizeBytes?: number; sha256?: string }> };
    format?: {
      id?: string;
      version?: number;
      tensor?: string;
      requiresRuntime?: string;
      storage?: string;
      groupSize?: number;
    };
  };
}

interface ParsedArtifactFormat {
  format: Ds4ArtifactFormat | null;
  error: string | null;
}

interface ExpertMajorIdentity {
  present: boolean;
  format: Ds4ArtifactFormat | null;
  version: string | null;
}

const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function artifactFormatFromVersion(version: number): Ds4ArtifactFormat | null {
  return version === 2 ? "ds4-expert-major-v2" : null;
}

function expectedArtifactFormat(...identity: Array<string | null | undefined>): ExpertMajorIdentity {
  const match = identity.join(" ").match(/(?:^|[-_. ])expert[-_. ]?major(?:[-_. ]?v(\d+))?(?:$|[-_. ])/i);
  if (!match) return { present: false, format: null, version: null };
  const version = match[1] ?? null;
  return {
    present: true,
    format: version ? artifactFormatFromVersion(Number(version)) : null,
    version
  };
}

function parseArtifactFormat(manifest: DsboxManifest | null): ParsedArtifactFormat {
  const declaration = manifest?.artifact?.format;
  if (!declaration) return { format: null, error: null };
  const version = declaration.version;
  const format = typeof version === "number" && Number.isInteger(version)
    ? artifactFormatFromVersion(version)
    : null;
  if (declaration.id !== "ds4-expert-major" || !format) {
    return { format: null, error: "The DSBox manifest declares an unknown DS4 artifact format" };
  }
  if (declaration.tensor !== ds4ArtifactFormatTensor(format)) {
    return { format: null, error: `The DSBox manifest does not declare the ${format} tensor contract` };
  }
  if (declaration.requiresRuntime !== "andreaborio/ds4") {
    return { format: null, error: "DS4 ExpertMajor artifacts must declare andreaborio/ds4 as their required runtime" };
  }
  return { format, error: null };
}

function previousRepositories(manifest: DsboxManifest | null, repository: string): string[] {
  if (!Array.isArray(manifest?.previousRepositories)) return [];
  return [...new Set(manifest.previousRepositories
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter((candidate) => REPOSITORY_ID.test(candidate) && candidate !== repository))];
}

function cleanLabel(repository: string): string {
  return repository
    .split("/").at(-1)!
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase())
    .replace(/\bGlm52\b/g, "GLM 5.2")
    .replace(/\bDs4\b/g, "DS4")
    .replace(/\bDeepseek\b/g, "DeepSeek")
    .replace(/\bQwen3\.6\b/g, "Qwen3.6")
    .replace(/\b(\d+)g\b/gi, "$1 GB")
    .replace(/\bQ(\d+)k\b/gi, "Q$1_K");
}

function inferredModelId(repository: string, tags: string[]): string {
  const identity = `${repository} ${tags.join(" ")}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (identity.includes("qwen3 6 35b a3b") || identity.includes("qwen 3 6 35b a3b")) return "qwen3.6-35b-a3b";
  if (identity.includes("glm 5 2")) return "glm-5.2";
  if (identity.includes("deepseek v4")) return "deepseek-v4-flash";

  const repositoryName = repository.split("/").at(-1) ?? "model";
  return repositoryName
    .replace(/[-_]gguf$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "model";
}

function quantizationVariantCount(files: Array<HubSibling & { rfilename: string }>): number {
  const variants = new Set(files.map((file) => {
    const segments = file.rfilename.split("/");
    if (segments.length > 1) return segments.slice(0, -1).join("/");
    const shard = segments[0].match(/^(.*?)-\d{5}-of-\d{5}\.gguf$/i);
    return shard?.[1] ?? segments[0];
  }));
  return variants.size;
}

function catalogFile(file: HubSibling & { rfilename: string }, manifestPart?: { sizeBytes?: number; sha256?: string }): CatalogModelFile {
  return {
    name: file.rfilename,
    sizeBytes: Number(manifestPart?.sizeBytes ?? file.lfs?.size ?? file.size ?? 0),
    sha256: manifestPart?.sha256 ?? file.lfs?.sha256 ?? null
  };
}

function variantId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function shardIdentity(filename: string): { key: string; index: number; count: number } | null {
  const normalized = filename.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  const match = basename.match(/^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!match) return null;
  const directory = path.posix.dirname(normalized);
  return {
    key: `${directory === "." ? "" : `${directory}/`}${match[1]}`,
    index: Number(match[2]),
    count: Number(match[3])
  };
}

function variantLabel(key: string, files: CatalogModelFile[]): string {
  const directory = path.posix.dirname(files[0]?.name ?? "");
  if (directory && directory !== ".") return path.posix.basename(directory).replaceAll(/[-_]+/g, " ");
  const base = path.posix.basename(key || files[0]?.name || "GGUF", ".gguf");
  const quantization = base.match(/(?:^|[-_.])(UD[-_.])?(IQ\d(?:_[A-Z0-9]+)?|Q\d(?:_[A-Z0-9]+)?|BF16|F16)(?:$|[-_.])/i);
  return quantization?.[0]?.replace(/^[-_.]+|[-_.]+$/g, "").replaceAll(/[-_.]+/g, " ")
    || base.replaceAll(/[-_]+/g, " ");
}

function groupedGgufVariants(files: Array<HubSibling & { rfilename: string }>): CatalogModelVariant[] {
  const groups = new Map<string, Array<{ source: HubSibling & { rfilename: string }; shard: ReturnType<typeof shardIdentity> }>>();
  for (const file of files) {
    const shard = shardIdentity(file.rfilename);
    const key = shard?.key ?? file.rfilename;
    const group = groups.get(key) ?? [];
    group.push({ source: file, shard });
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, group]) => {
    group.sort((left, right) => (left.shard?.index ?? 0) - (right.shard?.index ?? 0));
    const catalogFiles = group.map(({ source }) => catalogFile(source));
    const shardCount = group[0]?.shard?.count ?? null;
    const completeShardSet = shardCount === null
      ? group.length === 1
      : group.length === shardCount
        && group.every(({ shard }, index) => shard?.count === shardCount && shard.index === index + 1);
    const sizesKnown = catalogFiles.every((file) => Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0);
    const installable = completeShardSet && sizesKnown;
    return {
      id: variantId(key),
      label: variantLabel(key, catalogFiles),
      files: catalogFiles,
      outputFile: catalogFiles[0]?.name ?? "",
      totalBytes: catalogFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      installable,
      unavailableReason: !completeShardSet
        ? "This quantization has an incomplete GGUF shard set"
        : !sizesKnown
          ? "Hugging Face did not publish the download size"
          : null,
      assembly: null
    };
  }).sort((left, right) => left.totalBytes - right.totalBytes || left.label.localeCompare(right.label));
}

function assemblyVariant(
  manifest: DsboxManifest,
  allFiles: Array<HubSibling & { rfilename: string }>
): CatalogModelVariant | null {
  const assembly = manifest.artifact?.assembly;
  const outputFile = manifest.artifact?.output;
  if (!assembly?.parts?.length || !outputFile) return null;
  if (!/^(?:concat|concatenate)$/i.test(assembly.type ?? "")) return null;
  const parts = assembly.parts.map((part) => {
    const filename = part.path?.trim();
    if (!filename) return null;
    const source = allFiles.find((file) => file.rfilename === filename);
    return source ? catalogFile(source, part) : null;
  });
  const missingPart = parts.some((part) => !part);
  const files = parts.filter((part): part is CatalogModelFile => Boolean(part));
  const sizesKnown = files.every((file) => Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0);
  const key = `assembly:${outputFile}:${files.map((file) => file.name).join("|")}`;
  return {
    id: variantId(key),
    label: variantLabel(outputFile, files),
    files,
    outputFile,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    installable: !missingPart && sizesKnown,
    unavailableReason: missingPart
      ? "The DSBox manifest references a missing model part"
      : !sizesKnown
        ? "The DSBox manifest does not declare every part size"
        : null,
    assembly: { type: "concatenate", outputFile }
  };
}

function inferredMultipartVariants(files: Array<HubSibling & { rfilename: string }>): CatalogModelVariant[] {
  const groups = new Map<string, Array<{ source: HubSibling & { rfilename: string }; index: number }>>();
  for (const file of files) {
    const normalized = file.rfilename.replaceAll("\\", "/");
    const match = normalized.match(/^(.*\.gguf)\.part-(\d+)$/i);
    if (!match) continue;
    const group = groups.get(match[1]) ?? [];
    group.push({ source: file, index: Number(match[2]) });
    groups.set(match[1], group);
  }
  return [...groups.entries()].map(([outputFile, parts]) => {
    parts.sort((left, right) => left.index - right.index);
    const catalogFiles = parts.map(({ source }) => catalogFile(source));
    const complete = parts.length > 0 && parts.every((part, index) => part.index === index + 1);
    const sizesKnown = catalogFiles.every((file) => Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0);
    return {
      id: variantId(`multipart:${outputFile}:${catalogFiles.map((file) => file.name).join("|")}`),
      label: variantLabel(outputFile, catalogFiles),
      files: catalogFiles,
      outputFile,
      totalBytes: catalogFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      installable: complete && sizesKnown,
      unavailableReason: !complete
        ? "This model has an incomplete multipart GGUF set"
        : !sizesKnown
          ? "Hugging Face did not publish every model part size"
          : null,
      assembly: { type: "concatenate", outputFile }
    };
  });
}

async function fetchJson<T>(url: string, timeout = 6000): Promise<T> {
  const response = await fetch(url, {
    headers: { "user-agent": "DSBox/0.1 (+local-model-catalog)" },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`Hugging Face responded with ${response.status}`);
  return response.json() as Promise<T>;
}

async function optionalManifest(repository: string, revision: string): Promise<DsboxManifest | null> {
  const url = `https://huggingface.co/${repository}/resolve/${revision}/dsbox.json`;
  try {
    const manifest = await fetchJson<DsboxManifest>(url, 2500);
    if (manifest.schemaVersion !== 1) return null;
    return manifest;
  } catch {
    return null;
  }
}

async function sourceSummaries(source: CatalogSourceDefinition): Promise<HubModel[]> {
  if (source.repositories) {
    return Promise.all(source.repositories.map((repository) =>
      fetchJson<HubModel>(`https://huggingface.co/api/models/${repository}?blobs=true`)
    ));
  }
  const url = `https://huggingface.co/api/models?author=${source.id}&filter=${source.filter ?? "gguf"}&sort=lastModified&direction=-1&limit=100&full=true`;
  return fetchJson<HubModel[]>(url);
}

async function pinnedDetails(source: CatalogSourceDefinition): Promise<HubModel[]> {
  const summaries = await sourceSummaries(source);
  const details = await Promise.all(summaries.slice(0, 20).map(async (summary) => {
    if (!summary.id?.startsWith(`${source.id}/`) || !summary.sha) return null;
    try {
      return await fetchJson<HubModel>(`https://huggingface.co/api/models/${summary.id}/revision/${summary.sha}?blobs=true`);
    } catch {
      return summary;
    }
  }));
  return details.filter((model): model is HubModel => Boolean(model?.id && model.sha));
}

async function catalogModel(model: HubModel, publisher: CatalogPublisher, totalMemoryBytes: number): Promise<CatalogModel> {
  const repository = model.id!;
  const revision = model.sha!;
  const tags = model.tags ?? [];
  const manifest = await optionalManifest(repository, revision);
  const experimental = tags.some((tag) => tag.toLowerCase() === "experimental")
    || manifest?.status?.toLowerCase() === "experimental"
    || repository.toLowerCase().includes("experimental");
  const allFiles = (model.siblings ?? []).filter((file): file is HubSibling & { rfilename: string } => Boolean(file.rfilename));
  const directGgufs = allFiles.filter((file) => file.rfilename.toLowerCase().endsWith(".gguf"));
  const groupedVariants = groupedGgufVariants(directGgufs);
  const declaredAssembly = manifest ? assemblyVariant(manifest, allFiles) : null;
  const inferredAssemblies = inferredMultipartVariants(allFiles);
  const discoveredVariants = declaredAssembly
    ? [declaredAssembly, ...groupedVariants.filter((variant) => variant.outputFile !== declaredAssembly.outputFile)]
    : [...groupedVariants, ...inferredAssemblies];
  const requestedFile = manifest?.file || (manifest?.artifact?.assembly ? undefined : manifest?.artifact?.output);
  const declaredSelectedVariant = declaredAssembly
    ?? (requestedFile
      ? discoveredVariants.find((variant) => variant.files.some((file) => file.name === requestedFile))
      : discoveredVariants.length === 1 ? discoveredVariants[0] : undefined);
  const manifestFileMissing = Boolean(requestedFile && !declaredSelectedVariant);
  const explicitModelId = manifest?.modelId?.trim() || manifest?.launch?.servedModelId?.trim() || null;
  const modelId = explicitModelId || inferredModelId(repository, tags);
  const runtimeBranch = manifest?.runtimeBranch?.trim() || manifest?.runtime?.branch?.trim() || null;
  const runtimeCommit = manifest?.runtimeCommit?.trim() || null;
  const parsedFormat = parseArtifactFormat(manifest);
  const expertMajorIdentity = expectedArtifactFormat(repository, requestedFile);
  const expectedFormat = expertMajorIdentity.format;
  const artifactFormat = parsedFormat.format;
  const minimumMemoryGb = Number.isFinite(manifest?.minimumMemoryGb)
    ? Number(manifest?.minimumMemoryGb)
    : Number.isFinite(manifest?.requirements?.minUnifiedMemoryBytes)
      ? Number(manifest?.requirements?.minUnifiedMemoryBytes) / 1024 ** 3
      : null;
  const memoryFits = minimumMemoryGb !== null && totalMemoryBytes >= minimumMemoryGb * 1024 ** 3;
  let artifactPolicyError = parsedFormat.error;
  if (!artifactPolicyError && expertMajorIdentity.present && !expectedFormat) {
    artifactPolicyError = expertMajorIdentity.version
      ? `DSBox does not support DS4 ExpertMajor v${expertMajorIdentity.version}`
      : "DS4 ExpertMajor repositories must include a supported format version";
  }
  if (!artifactPolicyError && expectedFormat && !artifactFormat) {
    artifactPolicyError = `The ${expectedFormat} repository must declare its DS4-only artifact format in dsbox.json`;
  }
  if (!artifactPolicyError && expectedFormat && artifactFormat !== expectedFormat) {
    artifactPolicyError = `The repository name and manifest disagree about ${expectedFormat}`;
  }
  if (!artifactPolicyError && artifactFormat && !SUPPORTED_EXPERT_MAJOR_MODEL_IDS.has(modelId)) {
    artifactPolicyError = "DS4 ExpertMajor v2 requires a pinned Qwen3.6, DeepSeek V4 Flash, or GLM-5.2 model contract";
  }
  const requiresExpertMajorV2 = modelId === "qwen3.6-35b-a3b"
    || modelId.startsWith("deepseek")
    || modelId === "glm-5.2";
  const expertMajorMinimumMemoryGb = modelId === "qwen3.6-35b-a3b"
    ? QWEN35_EXPERT_MAJOR_MINIMUM_MEMORY_GB
    : EXPERT_MAJOR_MINIMUM_MEMORY_GB;
  if (!artifactPolicyError && publisher !== "unsloth" && requiresExpertMajorV2 && artifactFormat !== "ds4-expert-major-v2") {
    artifactPolicyError = `${modelId} requires a manifest-pinned DS4 ExpertMajor v2 artifact`;
  }
  if (!artifactPolicyError && modelId === "qwen3.6-35b-a3b" && artifactFormat === "ds4-expert-major-v2" && (
    manifest?.artifact?.format?.storage !== "mlx-affine4"
    || manifest?.artifact?.format?.groupSize !== 64
  )) {
    artifactPolicyError = "Qwen3.6 requires a manifest-pinned ExpertMajor v2 MLX affine4/group-64 artifact";
  }
  if (!artifactPolicyError && artifactFormat && (
    minimumMemoryGb === null || minimumMemoryGb < expertMajorMinimumMemoryGb
  )) {
    artifactPolicyError = `DS4 ExpertMajor v2 requires a minimumMemoryGb declaration of at least ${expertMajorMinimumMemoryGb}`;
  }
  if (!artifactPolicyError && artifactFormat && manifest?.artifact?.assembly) {
    artifactPolicyError = "DS4 ExpertMajor v2 releases must publish one complete GGUF; multipart assembly is not supported";
  }
  if (!artifactPolicyError && artifactFormat && !requestedFile) {
    artifactPolicyError = "DS4 ExpertMajor manifests must pin one output file";
  }
  if (!artifactPolicyError && artifactFormat && runtimeBranch !== "main") {
    artifactPolicyError = "DS4 ExpertMajor v2 artifacts must pin the andreaborio/ds4 main runtime";
  }
  if (!artifactPolicyError && artifactFormat && (
    !runtimeBranch || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(runtimeCommit ?? "")
  )) {
    artifactPolicyError = "DS4 ExpertMajor artifacts require a revision-pinned DS4 runtime";
  }
  const declaredFiles = declaredSelectedVariant?.files ?? [];
  const declaredArtifactSize = manifest?.artifact?.sizeBytes;
  const declaredArtifactSha256 = manifest?.artifact?.sha256?.trim().toLowerCase() ?? null;
  const singleFileContractDeclared = manifest?.artifact?.output === requestedFile
    && Number.isSafeInteger(declaredArtifactSize)
    && Number(declaredArtifactSize) > 0
    && /^[a-f0-9]{64}$/.test(declaredArtifactSha256 ?? "");
  if (!artifactPolicyError && artifactFormat && !manifestFileMissing && !singleFileContractDeclared) {
    artifactPolicyError = "DS4 ExpertMajor v2 manifests must pin the single output file, byte size, and SHA-256";
  }
  if (!artifactPolicyError && artifactFormat && !manifestFileMissing && (
    declaredFiles.length !== 1
    || declaredFiles[0].sizeBytes !== declaredArtifactSize
    || declaredFiles[0].sha256?.toLowerCase() !== declaredArtifactSha256
  )) {
    artifactPolicyError = "The DSBox manifest size or SHA-256 does not match the pinned Hugging Face artifact";
  }

  const unsupportedUnverifiedGguf = publisher === "unsloth" && !manifest;
  const rawQwenSource = unsupportedUnverifiedGguf && /qwen3[._-]?6[-_. ]?35b[-_. ]?a3b/i.test(repository);
  let variants = unsupportedUnverifiedGguf
    ? discoveredVariants.map((variant) => ({
        ...variant,
        installable: false,
        unavailableReason: rawQwenSource
          ? "DS4 requires the normalized Qwen3.6 DS4 artifact; these source GGUF files are not directly runnable"
          : variant.files.length > 1
          ? "DS4 does not support standard multi-file GGUF sets"
          : "This repository does not declare a DS4-compatible model layout"
      }))
    : discoveredVariants;
  variants = variants.map((variant) => {
    const selected = declaredSelectedVariant?.id === variant.id;
    const variantIdentity = expectedArtifactFormat(repository, variant.outputFile);
    let unavailableReason = artifactPolicyError
      ?? (artifactFormat && !memoryFits
        ? `This ExpertMajor v2 model requires at least ${minimumMemoryGb} GiB of unified memory`
        : null);
    if (!unavailableReason && variantIdentity.present && !variantIdentity.format) {
      unavailableReason = variantIdentity.version
        ? `DSBox does not support DS4 ExpertMajor v${variantIdentity.version}`
        : "DS4 ExpertMajor artifacts must include a supported format version";
    }
    if (!unavailableReason && variantIdentity.format && !artifactFormat) {
      unavailableReason = `The ${variantIdentity.format} artifact must declare its DS4-only format in dsbox.json`;
    }
    if (
      !unavailableReason
      && variantIdentity.format
      && artifactFormat
      && variantIdentity.format !== artifactFormat
    ) {
      unavailableReason = `The artifact filename and manifest disagree about ${variantIdentity.format}`;
    }
    if (!unavailableReason && artifactFormat && !selected) {
      unavailableReason = "Only the manifest-pinned DS4 ExpertMajor artifact is installable from this repository";
    }
    return unavailableReason
      ? { ...variant, installable: false, unavailableReason }
      : variant;
  });
  let selectedVariant = declaredSelectedVariant
    ? variants.find((variant) => variant.id === declaredSelectedVariant.id)
    : undefined;
  const files = selectedVariant?.files ?? [];
  const stable = manifest?.status?.toLowerCase() === "stable";
  const compatibilityDeclared = minimumMemoryGb !== null
    && Boolean(explicitModelId)
    && Boolean(runtimeBranch)
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(runtimeCommit ?? "");
  const checksumAvailable = Boolean(files.length) && files.every((file) => /^[a-f0-9]{64}$/i.test(file.sha256 ?? ""));
  if (!artifactPolicyError && artifactFormat && !checksumAvailable) {
    artifactPolicyError = "DS4 ExpertMajor artifacts require a SHA-256 checksum for every published file";
    variants = variants.map((variant) => variant.id === selectedVariant?.id
      ? { ...variant, installable: false, unavailableReason: artifactPolicyError }
      : variant);
    selectedVariant = selectedVariant
      ? variants.find((variant) => variant.id === selectedVariant?.id)
      : undefined;
  }
  const installable = !manifestFileMissing && (requestedFile
    ? Boolean(selectedVariant?.installable)
    : variants.some((variant) => variant.installable));
  const variantCount = artifactFormat && installable
    ? variants.filter((variant) => variant.installable).length
    : variants.length || quantizationVariantCount(directGgufs);
  const recommended = manifest?.recommended === true && stable && Boolean(selectedVariant?.installable) && !experimental && memoryFits && compatibilityDeclared && checksumAvailable;
  const unavailableReason = unsupportedUnverifiedGguf
    ? variants[0]?.unavailableReason ?? "This repository does not declare a DS4-compatible model layout"
    : artifactPolicyError
      ?? (manifestFileMissing
      ? `The manifest references a missing file: ${requestedFile}`
      : selectedVariant?.unavailableReason
        ?? (installable && !selectedVariant && variantCount > 1
          ? "Choose a quantization in DSBox"
          : installable
            ? null
            : "No complete installable GGUF bundle detected"));
  return {
    publisher,
    repository,
    revision,
    label: manifest?.name?.trim() || cleanLabel(repository).replace(/\s+GGUF$/i, ""),
    description: manifest?.description?.trim()
      || (publisher === "unsloth"
        ? rawQwenSource
          ? "Upstream Qwen3.6 GGUF source. DSBox keeps it visible for provenance; DS4 runs only the normalized DS4 artifact."
          : "Unsloth GGUF repository. Standard multipart builds are visible for reference but cannot run in DS4."
        : experimental
          ? "Experimental version available for advanced testing."
          : "DS4 model published on Hugging Face."),
    modelId,
    runtimeBranch,
    runtimeCommit,
    files,
    outputFile: selectedVariant?.outputFile ?? null,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    recommended,
    experimental,
    installable,
    minimumMemoryGb,
    lastModified: model.lastModified ?? null,
    sourceUrl: `https://huggingface.co/${repository}/tree/${revision}`,
    unavailableReason,
    variantCount,
    variants,
    artifactFormat,
    previousRepositories: previousRepositories(manifest, repository),
    architecture: manifest?.architecture
      ?? model.architecture
      ?? (rawQwenSource ? "moe" : null)
  };
}

export class ModelCatalog {
  private cache: CatalogResponse | null = null;
  private cachedAt = 0;

  async list(totalMemoryBytes: number, force = false): Promise<CatalogResponse> {
    if (!force && this.cache && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return structuredClone(this.cache);
    }
    try {
      const sourceResults = await Promise.all(SOURCE_DEFINITIONS.map(async (source) => {
        try {
          const details = await pinnedDetails(source);
          return await Promise.all(details.map((model) => catalogModel(model, source.id, totalMemoryBytes)));
        } catch {
          return null;
        }
      }));
      if (sourceResults.every((result) => result === null)) throw new Error("Every model source is unavailable");
      const models = sourceResults.flatMap((result) => result ?? [])
        .filter((model) => !HIDDEN_REPOSITORIES.has(model.repository))
        .sort((left, right) => Number(right.recommended) - Number(left.recommended)
          || left.publisher.localeCompare(right.publisher)
          || left.label.localeCompare(right.label));

      const response: CatalogResponse = {
        author: AUTHOR,
        label: "DSBox Models",
        sources: CATALOG_SOURCES,
        models,
        recommended: models.find((model) => model.recommended) ?? null,
        refreshedAt: new Date().toISOString(),
        stale: false
      };
      this.cache = response;
      this.cachedAt = Date.now();
      return structuredClone(response);
    } catch {
      if (this.cache) return { ...structuredClone(this.cache), stale: true };
      return {
        author: AUTHOR,
        label: "DSBox Models",
        sources: CATALOG_SOURCES,
        models: [],
        recommended: null,
        refreshedAt: new Date().toISOString(),
        stale: true
      };
    }
  }
}
