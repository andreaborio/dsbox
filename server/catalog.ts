import type { CatalogModel, CatalogResponse } from "../src/types.js";

const AUTHOR = "andreaborio" as const;
const CACHE_TTL_MS = 5 * 60 * 1000;

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

async function fetchJson<T>(url: string, timeout = 6000): Promise<T> {
  const response = await fetch(url, {
    headers: { "user-agent": "DSBox/0.1 (+local-model-catalog)" },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`Hugging Face ha risposto ${response.status}`);
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

export class ModelCatalog {
  private cache: CatalogResponse | null = null;
  private cachedAt = 0;

  async list(totalMemoryBytes: number, force = false): Promise<CatalogResponse> {
    if (!force && this.cache && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return structuredClone(this.cache);
    }
    try {
      const summaryUrl = `https://huggingface.co/api/models?author=${AUTHOR}&filter=ds4&sort=lastModified&direction=-1&limit=100&full=true`;
      const summaries = await fetchJson<HubModel[]>(summaryUrl);
      const details = await Promise.all(summaries.slice(0, 20).map(async (summary) => {
        if (!summary.id?.startsWith(`${AUTHOR}/`) || !summary.sha) return null;
        try {
          return await fetchJson<HubModel>(`https://huggingface.co/api/models/${summary.id}/revision/${summary.sha}?blobs=true`);
        } catch {
          return summary;
        }
      }));

      const models = (await Promise.all(details.filter((model): model is HubModel => Boolean(model?.id && model.sha)).map(async (model): Promise<CatalogModel> => {
        const repository = model.id!;
        const revision = model.sha!;
        const tags = model.tags ?? [];
        const manifest = await optionalManifest(repository, revision);
        const experimental = tags.some((tag) => tag.toLowerCase() === "experimental")
          || manifest?.status?.toLowerCase() === "experimental"
          || repository.toLowerCase().includes("experimental");
        const allFiles = (model.siblings ?? []).filter((file): file is HubSibling & { rfilename: string } => Boolean(file.rfilename));
        const directGgufs = allFiles.filter((file) => file.rfilename.toLowerCase().endsWith(".gguf"));
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
          ? `Il manifest indica un file assente: ${requestedFile}`
          : installable
          ? minimumMemoryGb !== null && !memoryFits ? `Richiede almeno ${minimumMemoryGb} GB di memoria` : null
          : multipart.length
            ? "Pubblicato in più parti: installazione manuale richiesta"
            : "Nessun GGUF installabile rilevato";
        return {
          repository,
          revision,
          label: manifest?.name?.trim() || cleanLabel(repository),
          description: manifest?.description?.trim()
            || (experimental
              ? "Versione sperimentale disponibile per prove avanzate."
              : "Modello DS4 pubblicato su Hugging Face."),
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
          sourceUrl: `https://huggingface.co/${repository}`,
          unavailableReason
        };
      }))).sort((left, right) => Number(right.recommended) - Number(left.recommended));

      const response: CatalogResponse = {
        author: AUTHOR,
        label: "Modelli DSBox",
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
        label: "Modelli DSBox",
        models: [],
        recommended: null,
        refreshedAt: new Date().toISOString(),
        stale: true
      };
    }
  }
}
