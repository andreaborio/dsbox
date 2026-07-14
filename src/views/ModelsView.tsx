import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Box,
  Check,
  CircleStop,
  Download,
  FileBox,
  FolderOpen,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ModelDownloadDialog } from "../components/ModelDownloadDialog";
import { Button, Modal } from "../components/ui";
import { Badge, Progress } from "../design-system";
import type { DsboxController } from "../hooks/useDsbox";
import { apiRequest } from "../lib/api";
import { formatBytes, formatModelName } from "../lib/format";
import { currentDownload, downloadStageLabel, formatDownloadEta, resumableDownload } from "../lib/model-download-state";
import { assessLocalModelHardware, assessModelHardware } from "../lib/model-hardware-advisor";
import { catalogModelForVariant, chooseDefaultCatalogVariant } from "../lib/model-variants";
import type {
  AppSnapshot,
  CatalogModel,
  CatalogPublisher,
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
  { id: "catalog", label: "DS4 models" },
  { id: "unsloth", label: "Unsloth" },
  { id: "local", label: "On this Mac" }
];

function modelPublisher(model: CatalogModel): CatalogPublisher {
  if (model.publisher === "unsloth" || model.repository.startsWith("unsloth/")) return "unsloth";
  if (model.publisher === "antirez" || model.repository.startsWith("antirez/")) return "antirez";
  return "andreaborio";
}

function publisherLabel(publisher: CatalogPublisher): string {
  if (publisher === "antirez") return "DwarfStar";
  if (publisher === "unsloth") return "Unsloth";
  return "DSBox";
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
  if (scan.status === "complete") return scan.models.length === 1 ? "1 compatible GGUF found" : `${scan.models.length} compatible GGUFs found`;
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
  const [discardDownloadId, setDiscardDownloadId] = useState<string | null>(null);

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

  const activeDownload = currentDownload(snapshot.downloads);
  const pausedDownload = activeDownload ? null : resumableDownload(snapshot.downloads);
  const runtimeBusy = Boolean(activeDownload) || ["preparing", "installing", "updating", "building", "downloading", "starting", "running", "stopping"].includes(snapshot.runtime.phase);
  const downloadActive = Boolean(activeDownload);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleLocalModels = useMemo(() => localModels.filter((model) => {
    if (!normalizedQuery) return true;
    return [model.name, model.modelId, model.path].some((value) => value.toLowerCase().includes(normalizedQuery));
  }), [localModels, normalizedQuery]);
  const visibleCatalogModels = useMemo(() => [...(catalog?.models ?? [])]
    .sort((left, right) => Number(right.recommended) - Number(left.recommended) || left.label.localeCompare(right.label))
    .filter((model) => {
      const publisher = modelPublisher(model);
      if (filter === "catalog" && publisher === "unsloth") return false;
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
      setFinderMessage(`${result.model.name} is compatible with DS4 and ready to use.`);
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

  const beginDownload = async (variantId: string) => {
    if (!downloadModel) return;
    const selected = downloadModel;
    setDownloadModel(null);
    await controller.action("Download model", "/api/models/download", {
      repository: selected.repository,
      variantId
    });
    await controller.refresh();
  };

  const pauseDownload = async () => {
    if (!activeDownload) return;
    await controller.action("Pausing download", `/api/models/downloads/${activeDownload.id}/cancel`, { removePartials: false });
    await controller.refresh();
  };

  const resumeDownload = async () => {
    if (!pausedDownload) return;
    await controller.action("Resuming download", `/api/models/downloads/${pausedDownload.id}/resume`);
    await controller.refresh();
  };

  const discardDownload = async () => {
    if (!discardDownloadId) return;
    const id = discardDownloadId;
    setDiscardDownloadId(null);
    await controller.action("Cancelling download", `/api/models/downloads/${id}/cancel`, { removePartials: true });
    await controller.refresh();
  };

  const diskFreeBytes = snapshot.metrics.at(-1)?.diskFreeBytes ?? 0;

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

        {activeDownload && (
          <section className="model-task-banner" aria-label="Active model download">
            <span className="model-task-banner__icon"><Download size={17} /></span>
            <div className="model-task-banner__body">
              <div className="model-task-banner__head">
                <div>
                  <strong>{downloadStageLabel(activeDownload.stage)}</strong>
                  <p>{activeDownload.label} · {activeDownload.variantLabel}</p>
                </div>
                <Badge tone="accent">Hugging Face</Badge>
              </div>
              <Progress
                label={`${formatBytes(activeDownload.downloadedBytes, 1)} of ${formatBytes(activeDownload.totalBytes, 1)}`}
                value={activeDownload.downloadedBytes}
                max={activeDownload.totalBytes || 1}
                valueText={`${Math.round((activeDownload.downloadedBytes / Math.max(activeDownload.totalBytes, 1)) * 100)}%`}
                size="sm"
              />
              <div className="model-task-banner__meta">
                <span>{activeDownload.speedBytesPerSecond > 0 ? `${formatBytes(activeDownload.speedBytesPerSecond, 1)}/s` : "Establishing connection…"}</span>
                {formatDownloadEta(activeDownload.etaSeconds) && <span>{formatDownloadEta(activeDownload.etaSeconds)}</span>}
                <span>{activeDownload.files.filter((file) => file.stage === "complete").length}/{activeDownload.files.length} files verified</span>
              </div>
            </div>
            <div className="model-task-banner__actions">
              <Button variant="secondary" icon={<Pause size={14} />} onClick={() => void pauseDownload().catch(() => undefined)}>Pause</Button>
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDiscardDownloadId(activeDownload.id)}>Cancel</Button>
            </div>
          </section>
        )}

        {pausedDownload && (
          <section className={`model-task-banner model-task-banner--${pausedDownload.stage}`} aria-label="Paused model download">
            <span className="model-task-banner__icon"><Pause size={17} /></span>
            <div className="model-task-banner__body">
              <div className="model-task-banner__head">
                <div>
                  <strong>{downloadStageLabel(pausedDownload.stage)}</strong>
                  <p>{pausedDownload.error ?? `${pausedDownload.label} · ${formatBytes(pausedDownload.downloadedBytes, 1)} kept on this Mac`}</p>
                </div>
              </div>
              <Progress
                label={`${formatBytes(pausedDownload.downloadedBytes, 1)} of ${formatBytes(pausedDownload.totalBytes, 1)}`}
                value={pausedDownload.downloadedBytes}
                max={pausedDownload.totalBytes || 1}
                valueText={`${Math.round((pausedDownload.downloadedBytes / Math.max(pausedDownload.totalBytes, 1)) * 100)}%`}
                tone={pausedDownload.stage === "error" ? "danger" : "neutral"}
                size="sm"
              />
            </div>
            <div className="model-task-banner__actions">
              <Button variant="primary" icon={<Play size={14} />} onClick={() => void resumeDownload().catch(() => undefined)}>Resume</Button>
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDiscardDownloadId(pausedDownload.id)}>Remove</Button>
            </div>
          </section>
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
                <div><span>{scan.progress.candidateFiles} candidate files</span><span>{scan.progress.modelsFound} DS4-compatible models</span></div>
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
              <div className="models-empty"><RefreshCw className="spin" size={17} /><div><strong>Checking model compatibility</strong><p>DSBox reads GGUF headers and tensor indexes without loading model weights.</p></div></div>
            ) : visibleLocalModels.length ? (
              <motion.div className="local-results" layout>
                <AnimatePresence initial={false}>
                  {visibleLocalModels.map((model) => {
                    const filename = model.path.split("/").at(-1) ?? model.name;
                    const assessment = assessLocalModelHardware(model, {
                      totalMemoryBytes: snapshot.system.totalMemoryBytes,
                      diskFreeBytes
                    });
                    return (
                      <motion.article key={model.path} layout initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={model.selected ? "local-result local-result--active" : "local-result"}>
                        <span className="local-result__icon"><FileBox size={17} /></span>
                        <div className="local-result__copy"><div><strong>{formatModelName(model.modelId)}</strong>{model.selected && <span className="active-chip"><i /> Active</span>}</div><span>{filename}</span><code title={model.path}>{model.path}</code></div>
                        <div className="local-result__meta"><strong>{formatBytes(model.sizeBytes, 1)}</strong><span className={`model-advisor-label model-advisor-label--${assessment.performance.level}`} title={assessment.performance.explanation}>{assessment.performance.label}</span><small>{assessment.compatibility.label}</small></div>
                        <Button variant={model.selected ? "ghost" : "secondary"} icon={model.selected ? <Check size={14} /> : undefined} disabled={model.selected || runtimeBusy} loading={selectingPath === model.path} onClick={() => void useLocalModel(model)}>{model.selected ? "In use" : "Use"}</Button>
                      </motion.article>
                    );
                  })}
                </AnimatePresence>
              </motion.div>
            ) : (
              <div className="models-empty"><HardDrive size={17} /><div><strong>{normalizedQuery ? "No matching local models" : "No compatible GGUF models found"}</strong><p>Scan this Mac or choose a DS4 model directly in Finder.</p></div></div>
            )}

            <p className="local-discovery-card__privacy"><ShieldCheck size={13} /> Files stay where they are. DSBox checks the GGUF header and tensor index before a model can be selected.</p>
          </section>
        )}

        {filter !== "local" && (
          <section className="catalog-section" aria-labelledby="catalog-title">
            <div className="catalog-section__head"><div><span className="eyebrow">{filter === "unsloth" ? "External Hugging Face source" : filter === "catalog" ? "Verified for the DS4 engine" : "Curated Hugging Face sources"}</span><h2 id="catalog-title">{filter === "unsloth" ? "Unsloth models" : filter === "catalog" ? "DS4 models" : "Model sources"}</h2><p>{filter === "unsloth" ? "Models remain visible for provenance, but downloads are disabled until their layout is verified for DS4." : "Compatible files download inside DSBox, resume after interruptions, and stay pinned to a specific revision."}</p></div><Button variant="ghost" icon={<RefreshCw size={14} />} disabled={catalogLoading} onClick={() => void refreshCatalog(true)}>Refresh</Button></div>

            {catalogLoading ? (
              <div className="models-empty models-empty--panel"><RefreshCw className="spin" size={17} /><div><strong>Loading the DSBox catalog</strong><p>{downloadActive ? "Your current download continues while the catalog refreshes." : "No download has started."}</p></div></div>
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
                  const defaultVariant = chooseDefaultCatalogVariant(model, snapshot.system.totalMemoryBytes);
                  const assessedModel = defaultVariant ? catalogModelForVariant(model, defaultVariant) : model;
                  const assessment = assessModelHardware(assessedModel, {
                    totalMemoryBytes: snapshot.system.totalMemoryBytes,
                    diskFreeBytes
                  });
                  const selectable = model.installable && branchCompatible && Boolean(defaultVariant) && !runtimeBusy;
                  const unavailable = (!model.installable ? model.unavailableReason : null)
                    ?? (!branchCompatible ? `Requires the ${model.runtimeBranch} engine channel` : null)
                    ?? (!defaultVariant ? "No complete GGUF version is available" : null)
                    ?? (runtimeBusy ? "Turn off DSBox before changing models" : null);
                  return (
                    <article className={`${active ? "catalog-card catalog-card--active" : "catalog-card"} ${publisher === "unsloth" ? "catalog-card--unsloth" : ""}`} key={model.repository}>
                      <div className="catalog-card__head"><span className={`catalog-card__tile ${model.experimental ? "catalog-card__tile--experimental" : ""} ${publisher === "unsloth" ? "catalog-card__tile--unsloth" : ""}`}><Box size={22} /></span><div><div><h3>{model.label}</h3>{model.recommended && <span className="dsbox-recommended">Recommended by DSBox</span>}{publisher !== "andreaborio" && <span className="source-chip">{publisherLabel(publisher)}</span>}{model.experimental && <span className="experimental-chip">Experimental</span>}{active && <span className="active-chip"><i /> Active</span>}</div><p>Hugging Face · {model.repository}</p></div></div>
                      <p className="catalog-card__description">{model.description}</p>
                      <div className="catalog-card__facts"><span>{model.variantCount > 1 ? `${model.variantCount} versions` : defaultVariant ? formatBytes(defaultVariant.totalBytes, 0) : "Size unavailable"}</span>{model.minimumMemoryGb && <span>{model.minimumMemoryGb} GB publisher guidance</span>}<span>{defaultVariant?.files.length === 1 ? "Single GGUF" : defaultVariant ? `${defaultVariant.files.length} shards` : "GGUF"}</span>{defaultVariant?.files.every((file) => file.sha256) && <span>Checksums published</span>}</div>
                      <div className={`catalog-card__advisor catalog-card__advisor--${assessment.performance.level}`} title={assessment.performance.explanation}>
                        <span className="catalog-card__advisor-icon" aria-hidden="true">{assessment.performance.level === "very-slow" || assessment.performance.level === "may-be-slow" ? <AlertTriangle size={15} /> : <HardDrive size={15} />}</span>
                        <div><span>On this {Math.round(memoryGb)} GB Mac</span><strong>{assessment.performance.label}</strong></div>
                        <Badge tone="neutral" icon={assessment.compatibility.status === "verified" ? <ShieldCheck size={12} /> : undefined}>{assessment.compatibility.label}</Badge>
                      </div>
                      <div className="catalog-card__footer">
                        {active ? <span className="catalog-card__active-label"><Check size={14} /> Ready on this Mac</span> : selectable ? <Button variant="primary" icon={<Download size={14} />} onClick={() => setDownloadModel(model)}>{model.variantCount > 1 ? "Choose & download" : assessment.requiresAcknowledgement ? "Review download" : "Download & use"}</Button> : <span className="catalog-card__unavailable">{unavailable ?? "No downloadable version"}</span>}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="models-empty models-empty--panel"><Box size={17} /><div><strong>{normalizedQuery ? "No source models match your search" : "No models are available from this source"}</strong><p>You can continue using a GGUF already on this Mac.</p></div></div>
            )}
            <p className="catalog-provenance">Publisher labels identify where files are hosted. DSBox enables downloads only for model layouts verified against the DS4 engine.</p>
          </section>
        )}
      </div>

      <ModelDownloadDialog
        model={downloadModel}
        totalMemoryBytes={snapshot.system.totalMemoryBytes}
        diskFreeBytes={diskFreeBytes}
        busy={controller.busyAction === "Download model"}
        onClose={() => setDownloadModel(null)}
        onConfirm={beginDownload}
      />

      <Modal
        open={Boolean(discardDownloadId)}
        onClose={() => setDiscardDownloadId(null)}
        title="Cancel this download?"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setDiscardDownloadId(null)}>Keep download</Button>
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => void discardDownload().catch(() => undefined)}>Cancel & remove files</Button>
          </>
        )}
      >
        <div className="model-download-cancel-copy">
          <span><Trash2 size={18} /></span>
          <div>
            <strong>Partial files will be deleted</strong>
            <p>Pause instead if you want to continue later without downloading the same bytes again.</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
