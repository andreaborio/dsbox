import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Box,
  Check,
  CircleStop,
  Download,
  ExternalLink,
  FileBox,
  FolderOpen,
  HardDrive,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal } from "../components/ui";
import type { DsboxController } from "../hooks/useDsbox";
import { apiRequest } from "../lib/api";
import { formatBytes, formatModelName } from "../lib/format";
import type {
  AppSnapshot,
  CatalogModel,
  CatalogResponse,
  LocalModelCandidate,
  LocalModelScanSnapshot,
  NativeModelSelectionResult,
  ViewId
} from "../types";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
  initialFilter?: ModelFilter;
}

type ModelFilter = "all" | "catalog" | "unsloth" | "local";

const filters: Array<{ id: ModelFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "catalog", label: "DSBox" },
  { id: "unsloth", label: "Unsloth" },
  { id: "local", label: "On this Mac" }
];

function modelPublisher(model: CatalogModel): "andreaborio" | "unsloth" {
  return model.publisher === "unsloth" || model.repository.startsWith("unsloth/") ? "unsloth" : "andreaborio";
}

function mergeCandidates(...groups: LocalModelCandidate[][]): LocalModelCandidate[] {
  const models = new Map<string, LocalModelCandidate>();
  for (const group of groups) {
    for (const model of group) {
      const current = models.get(model.path);
      models.set(model.path, current ? { ...current, ...model, selected: current.selected || model.selected } : model);
    }
  }
  return [...models.values()].sort((left, right) =>
    Number(right.selected) - Number(left.selected)
    || right.sizeBytes - left.sizeBytes
    || left.name.localeCompare(right.name)
  );
}

function scanStageLabel(scan: LocalModelScanSnapshot): string {
  if (scan.status === "idle") return "Find GGUF models without moving, copying, or uploading them.";
  if (scan.status === "cancelled") return "Scan stopped";
  if (scan.status === "error") return "Scan could not finish";
  if (scan.status === "complete") return scan.models.length === 1 ? "1 GGUF model found" : `${scan.models.length} GGUF models found`;
  if (scan.stage === "spotlight") return "Searching indexed folders and connected drives…";
  if (scan.stage === "filesystem") return "Searching common model folders…";
  if (scan.stage === "validating") return "Checking GGUF files…";
  return "Starting the scan…";
}

export function ModelsView({ snapshot, controller, initialFilter = "all" }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>(initialFilter);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [localModels, setLocalModels] = useState<LocalModelCandidate[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [scan, setScan] = useState<LocalModelScanSnapshot | null>(null);
  const [selectingPath, setSelectingPath] = useState<string | null>(null);
  const [finderOpen, setFinderOpen] = useState(false);
  const [finderMessage, setFinderMessage] = useState<string | null>(null);
  const [downloadModel, setDownloadModel] = useState<CatalogModel | null>(null);

  const refreshLocalModels = useCallback(async () => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const response = await apiRequest<{ models: LocalModelCandidate[] }>("/api/models/local");
      setLocalModels(response.models);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "Unable to check common model folders");
    } finally {
      setLocalLoading(false);
    }
  }, []);

  const refreshCatalog = useCallback(async (force = false) => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalog(await apiRequest<CatalogResponse>(`/api/models/catalog${force ? "?refresh=1" : ""}`));
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : "The DSBox catalog is unavailable");
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLocalModels();
    void refreshCatalog();
    void apiRequest<LocalModelScanSnapshot>("/api/models/local/scan")
      .then((result) => {
        setScan(result);
        if (result.models.length) setLocalModels((current) => mergeCandidates(current, result.models));
      })
      .catch(() => undefined);
  }, [refreshCatalog, refreshLocalModels]);

  useEffect(() => {
    if (scan?.status !== "scanning") return;
    let active = true;
    const poll = async () => {
      try {
        const result = await apiRequest<LocalModelScanSnapshot>("/api/models/local/scan");
        if (!active) return;
        setScan(result);
        if (result.models.length) setLocalModels((current) => mergeCandidates(current, result.models));
      } catch (reason) {
        if (active) setLocalError(reason instanceof Error ? reason.message : "Unable to read scan progress");
      }
    };
    const timer = window.setInterval(() => void poll(), 700);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [scan?.status]);

  const runtimeBusy = ["preparing", "installing", "updating", "building", "downloading", "starting", "running", "stopping"].includes(snapshot.runtime.phase);
  const downloadActive = snapshot.runtime.phase === "downloading";
  const normalizedQuery = query.trim().toLowerCase();
  const visibleLocalModels = useMemo(() => localModels.filter((model) => {
    if (!normalizedQuery) return true;
    return [model.name, model.modelId, model.path].some((value) => value.toLowerCase().includes(normalizedQuery));
  }), [localModels, normalizedQuery]);
  const visibleCatalogModels = useMemo(() => [...(catalog?.models ?? [])]
    .sort((left, right) => Number(right.recommended) - Number(left.recommended) || left.label.localeCompare(right.label))
    .filter((model) => {
      const publisher = modelPublisher(model);
      if (filter === "catalog" && publisher !== "andreaborio") return false;
      if (filter === "unsloth" && publisher !== "unsloth") return false;
      if (!normalizedQuery) return true;
      return [model.label, model.modelId, model.description, model.repository, publisher].some((value) => value.toLowerCase().includes(normalizedQuery));
    }), [catalog, filter, normalizedQuery]);

  const startScan = async () => {
    setLocalError(null);
    setFinderMessage(null);
    try {
      const result = await apiRequest<LocalModelScanSnapshot>("/api/models/local/scan", { method: "POST" });
      setScan(result);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "The scan could not start");
    }
  };

  const stopScan = async () => {
    try {
      const result = await apiRequest<LocalModelScanSnapshot>("/api/models/local/scan/cancel", { method: "POST" });
      setScan(result);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "The scan could not be stopped");
    }
  };

  const chooseInFinder = async () => {
    setFinderOpen(true);
    setFinderMessage(null);
    setLocalError(null);
    try {
      const result = await apiRequest<NativeModelSelectionResult>("/api/models/local/choose", { method: "POST" });
      if (result.cancelled || !result.model) {
        setFinderMessage("No file selected.");
        return;
      }
      setLocalModels((current) => mergeCandidates(current.map((model) => ({ ...model, selected: false })), [result.model!]));
      setFinderMessage(`${result.model.name} is ready to use. No download was started.`);
      await controller.refresh();
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "The selected file could not be used");
    } finally {
      setFinderOpen(false);
    }
  };

  const useLocalModel = async (model: LocalModelCandidate) => {
    setSelectingPath(model.path);
    setLocalError(null);
    try {
      const selected = await apiRequest<LocalModelCandidate>("/api/models/local/select", {
        method: "POST",
        body: JSON.stringify({ path: model.path })
      });
      setLocalModels((current) => mergeCandidates(current.map((candidate) => ({ ...candidate, selected: false })), [selected]));
      await controller.refresh();
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "This model could not be selected");
    } finally {
      setSelectingPath(null);
    }
  };

  const beginDownload = async () => {
    if (!downloadModel) return;
    const selected = downloadModel;
    setDownloadModel(null);
    await controller.action("Download model", "/api/models/download", { repository: selected.repository });
  };

  const downloadDestination = (model: CatalogModel) => {
    const repository = model.repository.split("/").at(-1) ?? "model";
    const filename = model.outputFile?.split("/").at(-1) ?? "model.gguf";
    return `~/.dsbox/models/${repository}/${model.revision}/${filename}`;
  };

  const diskFreeBytes = snapshot.metrics.at(-1)?.diskFreeBytes ?? 0;
  const downloadFits = !downloadModel || diskFreeBytes <= 0 || downloadModel.totalBytes <= diskFreeBytes;

  return (
    <div className="models-page page-scroll">
      <div className="models-page__inner">
        <div className="models-toolbar">
          <label className="models-search">
            <span className="sr-only">Search models</span>
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model sources and this Mac…" />
          </label>
          <div className="models-filter" role="group" aria-label="Model source">
            {filters.map((item) => <button key={item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label}</button>)}
          </div>
        </div>

        {downloadActive && (
          <div className="model-task-banner" role="status">
            <span className="model-task-banner__icon"><Download size={17} /></span>
            <div><strong>Downloading model</strong><p>{snapshot.runtime.currentTask ?? "The download is resumable if you stop it."}</p></div>
            <Button variant="secondary" icon={<CircleStop size={14} />} onClick={() => void controller.action("Stopping download", "/api/runtime/cancel-task").catch(() => undefined)}>Stop download</Button>
          </div>
        )}

        {filter !== "catalog" && filter !== "unsloth" && (
          <section className={`local-discovery-card ${scan?.status === "scanning" ? "local-discovery-card--scanning" : ""}`} aria-labelledby="local-models-title">
            <div className="local-discovery-card__head">
              <span className="local-discovery-card__icon"><HardDrive size={20} />{scan?.status === "scanning" && <i />}</span>
              <div>
                <h2 id="local-models-title">Models already on this Mac</h2>
                <p>{scan ? scanStageLabel(scan) : "Find GGUF models without moving, copying, or uploading them."}</p>
              </div>
              <div className="local-discovery-card__actions">
                {scan?.status === "scanning"
                  ? <Button variant="secondary" icon={<CircleStop size={14} />} onClick={() => void stopScan()}>Stop scan</Button>
                  : <Button variant="secondary" icon={<Search size={14} />} onClick={() => void startScan()}>Scan this Mac</Button>}
                <Button variant="primary" icon={<FolderOpen size={15} />} disabled={runtimeBusy} loading={finderOpen} onClick={() => void chooseInFinder()}>Choose GGUF file…</Button>
              </div>
            </div>

            {scan?.status === "scanning" && (
              <div className="scan-progress" role="status" aria-live="polite">
                <span className="scan-progress__track"><i /></span>
                <div><span>{scan.progress.candidateFiles} candidate files</span><span>{scan.progress.modelsFound} valid GGUF models</span></div>
              </div>
            )}

            {(scan?.warning || scan?.truncated) && (
              <div className="model-inline-note model-inline-note--warning"><AlertTriangle size={15} /><p>{scan.warning ?? "The scan reached its safety limit. Results may be incomplete; you can still choose a file directly."}</p></div>
            )}
            {scan?.status === "error" && <div className="model-inline-note model-inline-note--error"><AlertTriangle size={15} /><p>{scan.error ?? "The scan could not finish. Choose a GGUF file directly or try again."}</p></div>}
            {localError && <div className="model-inline-note model-inline-note--error" role="alert"><AlertTriangle size={15} /><p>{localError}</p></div>}
            {finderMessage && <div className="model-inline-note" role="status"><Check size={15} /><p>{finderMessage}</p></div>}
            {runtimeBusy && !downloadActive && <div className="model-inline-note model-inline-note--warning"><AlertTriangle size={15} /><p>Turn off DSBox and wait for the current operation to finish before changing models.</p></div>}

            {localLoading ? (
              <div className="models-empty"><RefreshCw className="spin" size={17} /><div><strong>Checking common model folders</strong><p>This quick check does not search the entire Mac.</p></div></div>
            ) : visibleLocalModels.length ? (
              <motion.div className="local-results" layout>
                <AnimatePresence initial={false}>
                  {visibleLocalModels.map((model) => {
                    const filename = model.path.split("/").at(-1) ?? model.name;
                    return (
                      <motion.article key={model.path} layout initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={model.selected ? "local-result local-result--active" : "local-result"}>
                        <span className="local-result__icon"><FileBox size={17} /></span>
                        <div className="local-result__copy"><div><strong>{formatModelName(model.modelId)}</strong>{model.selected && <span className="active-chip"><i /> Active</span>}</div><span>{filename}</span><code title={model.path}>{model.path}</code></div>
                        <div className="local-result__meta"><strong>{formatBytes(model.sizeBytes, 1)}</strong><span>GGUF detected</span></div>
                        <Button variant={model.selected ? "ghost" : "secondary"} icon={model.selected ? <Check size={14} /> : undefined} disabled={model.selected || runtimeBusy} loading={selectingPath === model.path} onClick={() => void useLocalModel(model)}>{model.selected ? "In use" : "Use"}</Button>
                      </motion.article>
                    );
                  })}
                </AnimatePresence>
              </motion.div>
            ) : (
              <div className="models-empty"><HardDrive size={17} /><div><strong>{normalizedQuery ? "No matching local models" : "No GGUF models found yet"}</strong><p>Scan this Mac or choose a GGUF file directly in Finder.</p></div></div>
            )}

            <p className="local-discovery-card__privacy"><ShieldCheck size={13} /> Files stay where they are. DSBox reads only what it needs to validate and run the selected model.</p>
          </section>
        )}

        {filter !== "local" && (
          <section className="catalog-section" aria-labelledby="catalog-title">
            <div className="catalog-section__head"><div><span className="eyebrow">{filter === "unsloth" ? "Published by Unsloth · surfaced by DSBox" : filter === "catalog" ? "Published by andreaborio · selected by DSBox" : "Hugging Face sources · organized by DSBox"}</span><h2 id="catalog-title">{filter === "unsloth" ? "Unsloth models" : filter === "catalog" ? "DSBox catalog" : "Model sources"}</h2><p>{filter === "unsloth" ? "Choose among official Unsloth GGUF repositories. No download starts automatically." : "Downloads are always explicit, resumable, and pinned to a verified revision."}</p></div><Button variant="ghost" icon={<RefreshCw size={14} />} disabled={catalogLoading} onClick={() => void refreshCatalog(true)}>Refresh</Button></div>

            {catalogLoading ? (
              <div className="models-empty models-empty--panel"><RefreshCw className="spin" size={17} /><div><strong>Loading the DSBox catalog</strong><p>No download has started.</p></div></div>
            ) : catalogError ? (
              <div className="models-empty models-empty--panel models-empty--error"><AlertTriangle size={17} /><div><strong>Catalog unavailable</strong><p>{catalogError}</p></div><Button variant="secondary" onClick={() => void refreshCatalog(true)}>Try again</Button></div>
            ) : visibleCatalogModels.length ? (
              <div className="catalog-grid">
                {visibleCatalogModels.map((model) => {
                  const publisher = modelPublisher(model);
                  const repositoryName = model.repository.split("/").at(-1) ?? "";
                  const active = snapshot.config.model.id === model.modelId && snapshot.config.model.path.includes(`/models/${repositoryName}/`);
                  const branchCompatible = !model.runtimeBranch || snapshot.config.repository.branch === model.runtimeBranch;
                  const memoryGb = snapshot.system.totalMemoryBytes / 1024 ** 3;
                  const memoryCompatible = !model.minimumMemoryGb || memoryGb >= model.minimumMemoryGb;
                  const selectable = model.installable && branchCompatible && memoryCompatible && model.totalBytes > 0 && !runtimeBusy;
                  const unavailable = model.unavailableReason
                    ?? (!branchCompatible ? `Requires the ${model.runtimeBranch} engine channel` : null)
                    ?? (!memoryCompatible ? `Requires at least ${model.minimumMemoryGb} GB of unified memory` : null)
                    ?? (!model.totalBytes ? "Download size unavailable" : null)
                    ?? (runtimeBusy ? "Turn off DSBox before changing models" : null);
                  return (
                    <article className={`${active ? "catalog-card catalog-card--active" : "catalog-card"} ${publisher === "unsloth" ? "catalog-card--unsloth" : ""}`} key={model.repository}>
                      <div className="catalog-card__head"><span className={`catalog-card__tile ${model.experimental ? "catalog-card__tile--experimental" : ""} ${publisher === "unsloth" ? "catalog-card__tile--unsloth" : ""}`}><Box size={22} /></span><div><div><h3>{model.label}</h3>{model.recommended && <span className="dsbox-recommended"><Sparkles size={11} /> Recommended by DSBox</span>}{publisher === "unsloth" && <span className="source-chip">Unsloth</span>}{model.experimental && <span className="experimental-chip">Experimental</span>}{active && <span className="active-chip"><i /> Active</span>}</div><p>Hugging Face · {model.repository}</p></div></div>
                      <p className="catalog-card__description">{model.description}</p>
                      <div className="catalog-card__facts"><span>{model.totalBytes ? formatBytes(model.totalBytes, 0) : model.variantCount ? `${model.variantCount} quantizations` : "Size unavailable"}</span>{model.minimumMemoryGb && <span>{model.minimumMemoryGb} GB minimum memory</span>}<span>{publisher === "unsloth" ? "Sharded GGUF variants" : model.files.length === 1 ? "Single GGUF" : `${model.files.length} files`}</span>{model.files[0]?.sha256 && <span>SHA-256 published</span>}</div>
                      <div className="catalog-card__compatibility"><div><span>{publisher === "unsloth" ? "Choose for this Mac" : "Hardware declaration"}</span><strong>{publisher === "unsloth" ? `Select a quantization for ${Math.round(memoryGb)} GB unified memory` : model.minimumMemoryGb ? memoryCompatible ? `Fits this ${Math.round(memoryGb)} GB Mac` : `Needs ${model.minimumMemoryGb} GB` : "Not provided by the publisher"}</strong></div><ShieldCheck size={16} /></div>
                      <div className="catalog-card__footer">
                        {active ? <span className="catalog-card__active-label"><Check size={14} /> Ready on this Mac</span> : selectable ? <Button variant="primary" icon={<Download size={14} />} onClick={() => setDownloadModel(model)}>Download {formatBytes(model.totalBytes, 0)} and use</Button> : <span className="catalog-card__unavailable">{unavailable ?? "Manual installation only"}</span>}
                        <a href={model.sourceUrl} target="_blank" rel="noopener noreferrer">{publisher === "unsloth" ? "Browse quantizations" : "View on Hugging Face"} <ExternalLink size={12} /></a>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="models-empty models-empty--panel"><Box size={17} /><div><strong>{normalizedQuery ? "No source models match your search" : "No models are available from this source"}</strong><p>You can continue using a GGUF already on this Mac.</p></div></div>
            )}
            <p className="catalog-provenance">Publisher labels identify where files are hosted. Only the “Recommended by DSBox” badge is a DSBox recommendation; publisher presence is never an endorsement.</p>
          </section>
        )}
      </div>

      <Modal
        open={Boolean(downloadModel)}
        onClose={() => setDownloadModel(null)}
        title="Confirm model download"
        footer={<><Button variant="ghost" onClick={() => setDownloadModel(null)}>Cancel</Button><Button variant="primary" icon={<Download size={14} />} disabled={!downloadFits} onClick={() => void beginDownload().catch(() => undefined)}>Download and use</Button></>}
      >
        {downloadModel && <div className="catalog-confirm"><span className="catalog-confirm__icon"><Download size={21} /></span><div><strong>{downloadModel.label}</strong><p>This file will be downloaded from Hugging Face. DSBox will select it after verification, but it will not start the server.</p></div><dl><div><dt>Download</dt><dd>{formatBytes(downloadModel.totalBytes, 1)}</dd></div><div><dt>Free space</dt><dd>{diskFreeBytes ? formatBytes(diskFreeBytes, 1) : "Checking…"}</dd></div><div className="catalog-confirm__destination"><dt>Destination</dt><dd title={downloadDestination(downloadModel)}>{downloadDestination(downloadModel)}</dd></div><div><dt>Revision</dt><dd>{downloadModel.revision.slice(0, 12)}</dd></div></dl>{!downloadFits && <div className="branch-warning"><AlertTriangle size={15} /><p>There is not enough free space on the model volume for this download.</p></div>}<div className="catalog-confirm__notice"><ShieldCheck size={15} /><p>The download starts only after you confirm it here. It is resumable and can be stopped at any time.</p></div></div>}
      </Modal>
    </div>
  );
}
