import type { CatalogModel, CatalogPublisher, CatalogResponse, CatalogSource } from "../src/types.js";

const AUTHOR = "andreaborio" as const;
const CACHE_TTL_MS = 5 * 60 * 1000;

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
      "unsloth/GLM-5.2-GGUF"
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

function inferredModelId(tags: string[]): string {
  if (tags.some((tag) => tag.toLowerCase().includes("glm-5.2"))) return "glm-5.2";
  return "deepseek-v4-flash";
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
  const variantCount = quantizationVariantCount(directGgufs);
  const requestedFile = manifest?.file || (manifest?.artifact?.assembly ? undefined : manifest?.artifact?.output);
  const manifestFile = requestedFile
    ? allFiles.find((file) => file.rfilename === requestedFile)
    : undefined;
  const manifestFileMissing = Boolean(requestedFile && !manifestFile);
  const selected = requestedFile
    ? manifestFile ? [manifestFile] : []
    : directGgufs.length === 1 ? directGgufs : [];
  const multipart = allFiles.filter((file) => /\.gguf\.part-\d+$/i.test(file.rfilename));
  const visibleFiles = selected.length ? selected : multipart;
  const files = visibleFiles.map((file) => ({
    name: file.rfilename,
    sizeBytes: Number(file.lfs?.size ?? file.size ?? 0),
    sha256: file.lfs?.sha256 ?? null
  }));
  const installable = selected.length === 1;
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
  const checksumAvailable = /^[a-f0-9]{64}$/i.test(files[0]?.sha256 ?? "");
  const recommended = manifest?.recommended === true && stable && installable && !experimental && memoryFits && compatibilityDeclared && checksumAvailable;
  const unavailableReason = manifestFileMissing
    ? `The manifest references a missing file: ${requestedFile}`
    : installable
      ? minimumMemoryGb !== null && !memoryFits ? `Requires at least ${minimumMemoryGb} GB of memory` : null
      : publisher === "unsloth" && variantCount
        ? "Choose a quantization on Hugging Face, then select its first GGUF shard in DSBox"
        : multipart.length
          ? "Published in multiple parts: manual installation required"
          : "No installable GGUF detected";
  return {
    publisher,
    repository,
    revision,
    label: manifest?.name?.trim() || cleanLabel(repository).replace(/\s+GGUF$/i, ""),
    description: manifest?.description?.trim()
      || (publisher === "unsloth"
        ? "Official Unsloth GGUF repository with multiple quantizations. Choose the variant that fits this Mac."
        : experimental
          ? "Experimental version available for advanced testing."
          : "DS4 model published on Hugging Face."),
    modelId: explicitModelId || inferredModelId(tags),
    runtimeBranch,
    runtimeCommit,
    files,
    outputFile: selected[0]?.rfilename ?? null,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    recommended,
    experimental,
    installable,
    minimumMemoryGb,
    lastModified: model.lastModified ?? null,
    sourceUrl: `https://huggingface.co/${repository}/tree/${revision}`,
    unavailableReason,
    variantCount
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
