import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CatalogModel,
  CatalogModelFile,
  CatalogModelVariant,
  CatalogPublisher,
  CatalogResponse,
  CatalogSource
} from "../src/types.js";

const AUTHOR = "andreaborio" as const;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CatalogSourceDefinition extends CatalogSource {
  filter?: string;
  repositories?: string[];
  trustedModels?: TrustedCatalogModelDefinition[];
}

interface TrustedCatalogModelDefinition {
  repository: string;
  revision: string;
  lastModified: string;
  tags: string[];
  file: Omit<CatalogModelFile, "sha256"> & { sha256: string };
  label: string;
  description: string;
  modelId: string;
  runtimeBranch: string;
  runtimeCommit: string;
  minimumMemoryGb: number;
  architecture: NonNullable<CatalogModel["architecture"]>;
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
      "unsloth/GLM-5.2-GGUF"
    ]
  },
  {
    id: "antirez",
    label: "DwarfStar",
    url: "https://huggingface.co/antirez/deepseek-v4-gguf",
    trustedModels: [
      {
        repository: "antirez/deepseek-v4-gguf",
        revision: "9170bf42beb77f38006e016503ecace31f2bd9a0",
        lastModified: "2026-05-31T11:28:43.000Z",
        tags: ["ds4", "deepseek-v4", "deepseek-v4-flash", "moe"],
        file: {
          name: "DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf",
          sizeBytes: 86_720_111_488,
          sha256: "efc7ed607ff27076e3e501fc3fefefa33c0ed8cf1eff483a2b7fdc0c2e616668"
        },
        label: "DeepSeek V4 Flash Q2 Imatrix",
        description: "DS4-native Flash model verified for Metal and SSD streaming.",
        modelId: "deepseek-v4-flash",
        runtimeBranch: "main",
        runtimeCommit: "1523b2681eefaf2688fc98be3fe629641ac314b0",
        minimumMemoryGb: 64,
        architecture: "moe"
      }
    ]
  }
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
  trustedManifest?: DsboxManifest;
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
  artifact?: {
    output?: string;
    sizeBytes?: number;
    sha256?: string;
    assembly?: { type?: string; parts?: Array<{ path?: string; sizeBytes?: number; sha256?: string }> };
  };
}

function cleanLabel(repository: string): string {
  return repository
    .split("/").at(-1)!
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase())
    .replace(/\bGlm52\b/g, "GLM 5.2")
    .replace(/\bDs4\b/g, "DS4")
    .replace(/\bDeepseek\b/g, "DeepSeek")
    .replace(/\b(\d+)g\b/gi, "$1 GB")
    .replace(/\bQ(\d+)k\b/gi, "Q$1_K");
}

function inferredModelId(repository: string, tags: string[]): string {
  const identity = `${repository} ${tags.join(" ")}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
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
  if (source.trustedModels) {
    return source.trustedModels.map((model) => ({ id: model.repository, sha: model.revision }));
  }
  if (source.repositories) {
    return Promise.all(source.repositories.map((repository) =>
      fetchJson<HubModel>(`https://huggingface.co/api/models/${repository}?blobs=true`)
    ));
  }
  const url = `https://huggingface.co/api/models?author=${source.id}&filter=${source.filter ?? "gguf"}&sort=lastModified&direction=-1&limit=100&full=true`;
  return fetchJson<HubModel[]>(url);
}

async function pinnedDetails(source: CatalogSourceDefinition): Promise<HubModel[]> {
  if (source.trustedModels) {
    const details = await Promise.all(source.trustedModels.map(async (trusted) => {
      const url = `https://huggingface.co/api/models/${trusted.repository}/revision/${trusted.revision}?blobs=true`;
      const model = await fetchJson<HubModel>(url);
      const file = model.siblings?.find((candidate) => candidate.rfilename === trusted.file.name);
      const sizeBytes = Number(file?.lfs?.size ?? file?.size ?? 0);
      const sha256 = file?.lfs?.sha256?.toLowerCase() ?? null;
      if (model.id !== trusted.repository
        || model.sha !== trusted.revision
        || sizeBytes !== trusted.file.sizeBytes
        || sha256 !== trusted.file.sha256) {
        throw new Error(`Pinned DwarfStar artifact metadata does not match ${trusted.repository}@${trusted.revision}`);
      }
      return {
        id: trusted.repository,
        sha: trusted.revision,
        lastModified: trusted.lastModified,
        tags: trusted.tags,
        siblings: [{
          rfilename: trusted.file.name,
          size: trusted.file.sizeBytes,
          lfs: { size: trusted.file.sizeBytes, sha256: trusted.file.sha256 }
        }],
        trustedManifest: {
          schemaVersion: 1,
          name: trusted.label,
          description: trusted.description,
          status: "stable",
          recommended: true,
          minimumMemoryGb: trusted.minimumMemoryGb,
          modelId: trusted.modelId,
          runtimeBranch: trusted.runtimeBranch,
          runtimeCommit: trusted.runtimeCommit,
          file: trusted.file.name
        },
        architecture: trusted.architecture
      } satisfies HubModel;
    }));
    return details;
  }
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
  const manifest = model.trustedManifest ?? await optionalManifest(repository, revision);
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
  const unsupportedUnverifiedGguf = publisher === "unsloth" && !manifest;
  const variants = unsupportedUnverifiedGguf
    ? discoveredVariants.map((variant) => ({
        ...variant,
        installable: false,
        unavailableReason: variant.files.length > 1
          ? "DS4 does not support standard multi-file GGUF sets"
          : "This repository does not declare a DS4-compatible model layout"
      }))
    : discoveredVariants;
  const variantCount = variants.length || quantizationVariantCount(directGgufs);
  const requestedFile = manifest?.file || (manifest?.artifact?.assembly ? undefined : manifest?.artifact?.output);
  const selectedVariant = declaredAssembly
    ?? (requestedFile
      ? variants.find((variant) => variant.files.some((file) => file.name === requestedFile))
      : variants.length === 1 ? variants[0] : undefined);
  const manifestFileMissing = Boolean(requestedFile && !selectedVariant);
  const files = selectedVariant?.files ?? [];
  const installable = !manifestFileMissing && variants.some((variant) => variant.installable);
  const minimumMemoryGb = Number.isFinite(manifest?.minimumMemoryGb)
    ? Number(manifest?.minimumMemoryGb)
    : Number.isFinite(manifest?.requirements?.minUnifiedMemoryBytes)
      ? Number(manifest?.requirements?.minUnifiedMemoryBytes) / 1024 ** 3
      : null;
  const memoryFits = minimumMemoryGb !== null && totalMemoryBytes >= minimumMemoryGb * 1024 ** 3;
  const stable = manifest?.status?.toLowerCase() === "stable";
  const explicitModelId = manifest?.modelId?.trim() || manifest?.launch?.servedModelId?.trim() || null;
  const runtimeBranch = manifest?.runtimeBranch?.trim() || manifest?.runtime?.branch?.trim() || null;
  const runtimeCommit = manifest?.runtimeCommit?.trim() || null;
  const compatibilityDeclared = minimumMemoryGb !== null
    && Boolean(explicitModelId)
    && Boolean(runtimeBranch)
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(runtimeCommit ?? "");
  const checksumAvailable = Boolean(files.length) && files.every((file) => /^[a-f0-9]{64}$/i.test(file.sha256 ?? ""));
  const recommended = manifest?.recommended === true && stable && Boolean(selectedVariant?.installable) && !experimental && memoryFits && compatibilityDeclared && checksumAvailable;
  const unavailableReason = unsupportedUnverifiedGguf
    ? variants[0]?.unavailableReason ?? "This repository does not declare a DS4-compatible model layout"
    : manifestFileMissing
      ? `The manifest references a missing file: ${requestedFile}`
      : selectedVariant?.unavailableReason
        ?? (installable && !selectedVariant && variantCount > 1
          ? "Choose a quantization in DSBox"
          : installable
            ? null
            : "No complete installable GGUF bundle detected");
  return {
    publisher,
    repository,
    revision,
    label: manifest?.name?.trim() || cleanLabel(repository).replace(/\s+GGUF$/i, ""),
    description: manifest?.description?.trim()
      || (publisher === "unsloth"
        ? "Unsloth GGUF repository. Standard multipart builds are visible for reference but cannot run in DS4."
        : experimental
          ? "Experimental version available for advanced testing."
          : "DS4 model published on Hugging Face."),
    modelId: explicitModelId || inferredModelId(repository, tags),
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
    architecture: model.architecture ?? null
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
