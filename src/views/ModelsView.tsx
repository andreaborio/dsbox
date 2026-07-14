import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Box,
  Check,
  ChevronDown,
  CircleStop,
  Download,
  ExternalLink,
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
import { ModelIdentityIcon } from "../components/ModelIdentityIcon";
import { Button, Modal } from "../components/ui";
import { Badge, Progress } from "../design-system";
import type { DsboxController } from "../hooks/useDsbox";
import { apiRequest } from "../lib/api";
import { formatBytes, formatModelName } from "../lib/format";
import { identifyModel } from "../lib/model-identity";
import { currentDownload, downloadStageLabel, formatDownloadEta, resumableDownload } from "../lib/model-download-state";
import { assessLocalModelHardware, assessModelHardware } from "../lib/model-hardware-advisor";
import { catalogModelForVariant, catalogModelIsReady, chooseDefaultCatalogVariant } from "../lib/model-variants";
import type {
  AppSnapshot,
  CatalogModel,
  CatalogPublisher,
  CatalogResponse,
  CatalogSource,
  LocalModelCandidate,
  LocalModelScanSnapshot,
  NativeModelSelectionResult,
  ViewId
} from "../types";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
  initialFilter?: ModelView;
}

type ModelView = "library" | "discover";

const views: Array<{ id: ModelView; label: string }> = [
  { id: "library", label: "Library" },
  { id: "discover", label: "Discover" }
];

function modelPublisher(model: CatalogModel): CatalogPublisher {
  return model.publisher?.trim() || model.repository.split("/")[0] || "unknown";
}

function publisherLabel(publisher: CatalogPublisher, sources: CatalogSource[]): string {
  const declared = sources.find((source) => source.id.toLowerCase() === publisher.toLowerCase());
  if (declared?.label) return declared.label;
  const normalized = publisher.toLowerCase();
  if (normalized === "andreaborio") return "DSBox";
  if (normalized === "antirez") return "DwarfStar";
  return publisher.replaceAll(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
  const ready = scan.models.filter((model) => model.compatibility.status === "compatible").length;
  if (scan.status === "idle") return "Find GGUF files on this Mac. Files stay where they are.";
  if (scan.status === "cancelled") return "Scan stopped";
  if (scan.status === "error") return "Scan could not finish";
  if (scan.status === "complete") return `Scan complete · ${scan.models.length} ${scan.models.length === 1 ? "file" : "files"} found · ${ready} ready now`;
  if (scan.stage === "spotlight") return "Searching indexed folders and connected drives…";
  if (scan.stage === "filesystem") return "Searching common model folders…";
  if (scan.stage === "validating") return "Reading GGUF metadata…";
  return "Starting the scan…";
}

export function ModelsView({ snapshot, controller, initialFilter = "library" }: Props) {
  const [query, setQuery] = useState("");
  const [activeView, setActiveView] = useState<ModelView>(initialFilter);
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
  const [unsupportedOpen, setUnsupportedOpen] = useState(true);
  const reduceMotion = useReducedMotion();

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
  const readyLocalModels = visibleLocalModels.filter((model) => model.compatibility.status === "compatible");
  const unsupportedLocalModels = visibleLocalModels.filter((model) => model.compatibility.status !== "compatible");
  const totalReadyLocalModels = localModels.filter((model) => model.compatibility.status === "compatible").length;
  const visibleCatalogModels = useMemo(() => [...(catalog?.models ?? [])]
    .sort((left, right) => Number(right.recommended) - Number(left.recommended) || left.label.localeCompare(right.label))
    .filter((model) => {
      const publisher = modelPublisher(model);
      if (!normalizedQuery) return true;
      return [model.label, model.modelId, model.description, model.repository, publisher].some((value) => value.toLowerCase().includes(normalizedQuery));
    }), [catalog, normalizedQuery]);
  const readyCatalogModels = visibleCatalogModels.filter((model) => catalogModelIsReady(model, snapshot.system.totalMemoryBytes));
  const unsupportedCatalogModels = visibleCatalogModels.filter((model) => !catalogModelIsReady(model, snapshot.system.totalMemoryBytes));

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
        return;
      }
      setLocalModels((current) => mergeCandidates(current, [result.model!]));
      setFinderMessage(result.model.compatibility.status === "compatible"
        ? `${result.model.name} was added to your library and is ready to use.`
        : `${result.model.name} was added to your library. This DS4 build cannot run it yet.`);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "The selected file could not be added");
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
  const catalogHeader = {
    eyebrow: "Hugging Face",
    title: "Discover models",
    description: "Download verified models directly in DSBox. Unsupported sources remain visible for reference."
  };

  const renderCatalogModel = (model: CatalogModel, unsupported = false) => {
    const publisher = modelPublisher(model);
    const sourceLabel = publisherLabel(publisher, catalog?.sources ?? []);
    const repositoryName = model.repository.split("/").at(-1) ?? "";
    const identity = identifyModel(model.modelId, model.label, model.repository);
    const active = snapshot.config.model.id === model.modelId && snapshot.config.model.path.includes(`/models/${repositoryName}/`);
    const defaultVariant = chooseDefaultCatalogVariant(model, snapshot.system.totalMemoryBytes);

    if (unsupported) {
      const reason = model.unavailableReason ?? (!defaultVariant ? "No complete DS4-compatible GGUF version is available." : "This model layout has not been verified for DS4.");
      return (
        <article className="catalog-card catalog-card--unsupported" key={model.repository}>
          <div className="catalog-card__head">
            <span className={`catalog-card__tile catalog-card__tile--${identity}`}><ModelIdentityIcon identity={identity} fallback={<Box size={18} />} /></span>
            <div>
              <div><h3>{model.label}</h3><span className="source-chip">{sourceLabel}</span></div>
              <p>Hugging Face · {model.repository}</p>
            </div>
          </div>
          <div className="catalog-card__unsupported-copy">
            <strong>Not supported by DS4</strong>
            <p>{reason}</p>
          </div>
          <a className="catalog-card__source-link" href={model.sourceUrl} target="_blank" rel="noreferrer">View source <ExternalLink size={12} /></a>
        </article>
      );
    }

    const branchCompatible = !model.runtimeBranch || snapshot.config.repository.branch === model.runtimeBranch;
    const memoryGb = snapshot.system.totalMemoryBytes / 1024 ** 3;
    const assessedModel = defaultVariant ? catalogModelForVariant(model, defaultVariant) : model;
    const assessment = assessModelHardware(assessedModel, {
      totalMemoryBytes: snapshot.system.totalMemoryBytes,
      diskFreeBytes
    });
    const selectable = model.installable && branchCompatible && Boolean(defaultVariant) && !runtimeBusy;
    const unavailable = (!branchCompatible ? `Requires the ${model.runtimeBranch} engine channel` : null)
      ?? (!defaultVariant ? "No complete GGUF version is available" : null)
      ?? (runtimeBusy ? "Turn off DSBox before changing models" : null);

    return (
      <article className={active ? "catalog-card catalog-card--active" : "catalog-card"} key={model.repository}>
        <div className="catalog-card__head"><span className={`catalog-card__tile catalog-card__tile--${identity} ${model.experimental ? "catalog-card__tile--experimental" : ""}`}><ModelIdentityIcon identity={identity} fallback={<Box size={22} />} /></span><div><div><h3>{model.label}</h3>{model.recommended && <span className="dsbox-recommended">Recommended by DSBox</span>}{publisher.toLowerCase() !== "andreaborio" && <span className="source-chip">{sourceLabel}</span>}{model.experimental && <span className="experimental-chip">Experimental</span>}{active && <span className="active-chip"><i /> Active</span>}</div><p>Hugging Face · {model.repository}</p></div></div>
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
  };

  const renderLocalModel = (model: LocalModelCandidate) => {
    const unsupported = model.compatibility.status !== "compatible";
    const filename = model.path.split("/").at(-1) ?? model.name;
    const identity = identifyModel(model.modelId, model.name, filename, model.path);
    const assessment = unsupported ? null : assessLocalModelHardware(model, {
      totalMemoryBytes: snapshot.system.totalMemoryBytes,
      diskFreeBytes
    });
    const rowClassName = [
      "local-result",
      model.selected ? "local-result--active" : "",
      unsupported ? "local-result--unsupported" : ""
    ].filter(Boolean).join(" ");

    return (
      <motion.article
        key={model.path}
        initial={reduceMotion ? false : { opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 2 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
        className={rowClassName}
        aria-disabled={unsupported || undefined}
        title={model.path}
      >
        <span className={`local-result__icon local-result__icon--${identity}`}><ModelIdentityIcon identity={identity} fallback={<FileBox size={17} />} /></span>
        <div className="local-result__copy">
          <div>
            <strong>{formatModelName(model.modelId)}</strong>
            {model.selected && <span className="active-chip"><i /> In use</span>}
            {unsupported && <span className="local-result__status">Unavailable</span>}
          </div>
          <span>{filename}</span>
          {unsupported
            ? <p className="local-result__reason" title={model.compatibility.reason ?? undefined}>{model.compatibility.reason ?? "This model is not supported by the current DS4 build."}</p>
            : <code title={model.path}>{model.path}</code>}
        </div>
        <div className="local-result__meta">
          <strong>{formatBytes(model.sizeBytes, 1)}</strong>
          {assessment
            ? <><span className={`model-advisor-label model-advisor-label--${assessment.performance.level}`} title={assessment.performance.explanation}>{assessment.performance.label}</span><small>Ready</small></>
            : <><span>{model.architecture ?? "GGUF"}</span><small>Library only</small></>}
        </div>
        {!unsupported && (
          <Button variant={model.selected ? "ghost" : "secondary"} icon={model.selected ? <Check size={14} /> : undefined} disabled={model.selected || runtimeBusy} loading={selectingPath === model.path} onClick={() => void useLocalModel(model)}>{model.selected ? "In use" : "Use"}</Button>
        )}
      </motion.article>
    );
  };

  return (
    <div className="models-page page-scroll">
      <div className="models-page__inner">
        <div className="models-toolbar">
          <div className="models-view-switcher" role="group" aria-label="Models view">
            {views.map((item) => (
              <button
                key={item.id}
                className={activeView === item.id ? "active" : ""}
                onClick={() => { setActiveView(item.id); setQuery(""); }}
                aria-pressed={activeView === item.id}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="models-search">
            <span className="sr-only">Search {activeView === "library" ? "your library" : "the model catalog"}</span>
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={activeView === "library" ? "Search your library…" : "Search Hugging Face models…"} />
          </label>
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

        {activeView === "library" && (
          <section className="local-library" aria-labelledby="local-models-title">
            <div className="local-library-toolbar">
              <div>
                <h2 id="local-models-title">On this Mac</h2>
                <p>{localLoading ? "Reading your local library…" : `${localModels.length} ${localModels.length === 1 ? "GGUF file" : "GGUF files"} · ${totalReadyLocalModels} ready to run`}</p>
              </div>
              <div className="local-library-toolbar__actions">
                {scan?.status === "scanning"
                  ? <Button variant="secondary" icon={<CircleStop size={14} />} onClick={() => void stopScan()}>Stop</Button>
                  : <Button variant="secondary" icon={<Search size={14} />} onClick={() => void startScan()}>Scan Mac</Button>}
                <Button variant="primary" icon={<FolderOpen size={15} />} loading={finderOpen} onClick={() => void chooseInFinder()}>Add GGUF…</Button>
              </div>
            </div>

            {scan && scan.status !== "idle" && (
              <div className={`local-scan-status local-scan-status--${scan.status}`} role="status" aria-live="polite">
                <div className="local-scan-status__copy">
                  {scan.status === "scanning" ? <RefreshCw className="spin" size={14} /> : scan.status === "complete" ? <Check size={14} /> : <HardDrive size={14} />}
                  <span>{scanStageLabel(scan)}</span>
                </div>
                {scan.status === "scanning" && (
                  <>
                    <span className="local-scan-status__track"><i /></span>
                    <div className="local-scan-status__meta">
                      <span>{scan.progress.candidateFiles} files found</span>
                      <span>{scan.models.filter((model) => model.compatibility.status === "compatible").length} ready to run</span>
                    </div>
                  </>
                )}
              </div>
            )}

            {(scan?.warning || scan?.truncated) && (
              <div className="model-inline-note model-inline-note--warning"><AlertTriangle size={15} /><p>{scan.warning ?? "The scan reached its safety limit. Results may be incomplete; you can still add a file directly."}</p></div>
            )}
            {scan?.status === "error" && <div className="model-inline-note model-inline-note--error"><AlertTriangle size={15} /><p>{scan.error ?? "The scan could not finish. Add a GGUF file directly or try again."}</p></div>}
            {localError && <div className="model-inline-note model-inline-note--error" role="alert"><AlertTriangle size={15} /><p>{localError}</p></div>}
            {finderMessage && <div className="model-inline-note" role="status"><Check size={15} /><p>{finderMessage}</p></div>}

            {localLoading ? (
              <div className="models-empty"><RefreshCw className="spin" size={17} /><div><strong>Reading your library</strong><p>DSBox checks metadata only. Model weights are not loaded.</p></div></div>
            ) : visibleLocalModels.length ? (
              <div className="local-library-groups">
                <div className="local-library-group">
                  <div className="local-library-group__head">
                    <div><h3>Ready to run</h3><p>Models compatible with this DS4 build.</p></div>
                    <span>{readyLocalModels.length}</span>
                  </div>
                  {readyLocalModels.length ? (
                    <div className="local-results"><AnimatePresence initial={false}>{readyLocalModels.map(renderLocalModel)}</AnimatePresence></div>
                  ) : (
                    <div className="models-empty"><HardDrive size={17} /><div><strong>No runnable models here yet</strong><p>Scan this Mac or add a compatible GGUF file.</p></div></div>
                  )}
                </div>

                {unsupportedLocalModels.length > 0 && (
                  <div className={`local-library-group local-library-group--unsupported ${unsupportedOpen || normalizedQuery ? "local-library-group--open" : ""}`}>
                    <button className="local-library-group__toggle" onClick={() => setUnsupportedOpen((open) => !open)} aria-expanded={unsupportedOpen || Boolean(normalizedQuery)}>
                      <div><h3>Unavailable in this DS4 build</h3><p>Saved in your library and rechecked after runtime updates.</p></div>
                      <span>{unsupportedLocalModels.length}<ChevronDown size={14} /></span>
                    </button>
                    <AnimatePresence initial={false}>
                      {(unsupportedOpen || Boolean(normalizedQuery)) && (
                        <motion.div className="local-results local-results--unsupported" initial={reduceMotion ? false : { opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -2 }} transition={reduceMotion ? { duration: 0 } : { duration: 0.14 }}>
                          {unsupportedLocalModels.map(renderLocalModel)}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            ) : (
              <div className="models-empty"><HardDrive size={17} /><div><strong>{normalizedQuery ? "No models match your search" : "Your library is empty"}</strong><p>Scan this Mac or add a GGUF file. Nothing is moved or uploaded.</p></div></div>
            )}

            <p className="local-library__privacy"><ShieldCheck size={13} /> Files stay in place. Compatibility checks never load model weights.</p>
          </section>
        )}

        {activeView === "discover" && (
          <section className="catalog-section" aria-labelledby="catalog-title">
            <div className="catalog-section__head"><div><span className="eyebrow">{catalogHeader.eyebrow}</span><h2 id="catalog-title">{catalogHeader.title}</h2><p>{catalogHeader.description}</p></div><Button variant="ghost" icon={<RefreshCw size={14} />} disabled={catalogLoading} onClick={() => void refreshCatalog(true)}>Refresh</Button></div>

            {catalogLoading ? (
              <div className="models-empty models-empty--panel"><RefreshCw className="spin" size={17} /><div><strong>Loading the DSBox catalog</strong><p>{downloadActive ? "Your current download continues while the catalog refreshes." : "No download has started."}</p></div></div>
            ) : catalogError ? (
              <div className="models-empty models-empty--panel models-empty--error"><AlertTriangle size={17} /><div><strong>Catalog unavailable</strong><p>{catalogError}</p></div><Button variant="secondary" onClick={() => void refreshCatalog(true)}>Try again</Button></div>
            ) : visibleCatalogModels.length ? (
              <div className="catalog-groups">
                {readyCatalogModels.length > 0 && (
                  <div className="catalog-group">
                    <div className="catalog-group__head"><div><h3>Ready to run</h3><p>Verified model layouts that DSBox can download and use.</p></div><span>{readyCatalogModels.length} {readyCatalogModels.length === 1 ? "model" : "models"}</span></div>
                    <div className="catalog-grid">{readyCatalogModels.map((model) => renderCatalogModel(model))}</div>
                  </div>
                )}
                {unsupportedCatalogModels.length > 0 && (
                  <div className={`catalog-group catalog-group--unsupported ${readyCatalogModels.length === 0 ? "catalog-group--standalone" : ""}`}>
                    <div className="catalog-group__head"><div><h3>Not supported by this DS4 build</h3><p>Kept for provenance. These files cannot be selected or downloaded in DSBox.</p></div><span>{unsupportedCatalogModels.length} {unsupportedCatalogModels.length === 1 ? "source" : "sources"}</span></div>
                    <div className="catalog-grid catalog-grid--unsupported">{unsupportedCatalogModels.map((model) => renderCatalogModel(model, true))}</div>
                  </div>
                )}
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
