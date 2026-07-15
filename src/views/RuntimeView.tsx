import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  Clock3,
  Cpu,
  ExternalLink,
  FolderGit2,
  Gauge,
  HardDrive,
  MemoryStick,
  MessageSquareText,
  Pause,
  ShieldCheck,
  Terminal,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot, CatalogResponse, DsboxConfig, EnginePhase, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { apiRequest } from "../lib/api";
import { shellDisplayArgument } from "../lib/arguments";
import { formatBytes, formatDuration, formatModelName, timeLabel } from "../lib/format";
import { currentDownload, formatDownloadEta } from "../lib/model-download-state";
import { BrandMark, Button, CopyButton, StatusPill } from "../components/ui";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

interface DiscoveredCheckout {
  path: string;
  branch: string | null;
  head: string | null;
}

const busyPhases: EnginePhase[] = ["preparing", "installing", "updating", "building", "downloading", "starting", "stopping"];

const copyByPhase: Record<EnginePhase, { title: string; description: string; action: string }> = {
  uninstalled: {
    title: "DSBox is off",
    description: "Turn it on and I'll automatically prepare everything this Mac needs.",
    action: "Turn on DSBox"
  },
  idle: {
    title: "DSBox is off",
    description: "Your model and settings stay ready. Turn it on whenever you want to use it.",
    action: "Turn on DSBox"
  },
  preparing: {
    title: "Preparing DSBox",
    description: "Choosing the right model and settings for this Mac.",
    action: "Preparing"
  },
  installing: {
    title: "Preparing DSBox",
    description: "Setting up the engine for this Mac. This is only required the first time.",
    action: "Preparing"
  },
  updating: {
    title: "Updating DSBox",
    description: "Applying updates without touching your local changes.",
    action: "Updating"
  },
  building: {
    title: "Optimizing for this Mac",
    description: "Building the Metal engine for your Apple silicon.",
    action: "Optimizing"
  },
  downloading: {
    title: "Downloading the model",
    description: "If you stop the download, it will resume where it left off.",
    action: "Downloading"
  },
  starting: {
    title: "Starting the model",
    description: "The first launch may take a few minutes. I'll let you know as soon as it's ready.",
    action: "Starting"
  },
  running: {
    title: "DSBox is on",
    description: "The model is ready for chat and your coding agents.",
    action: "Turn off"
  },
  stopping: {
    title: "Turning off DSBox",
    description: "Waiting for the context to be saved before shutting down.",
    action: "Shutting down"
  },
  error: {
    title: "DSBox couldn't start",
    description: "You can try again. Technical details are available below.",
    action: "Try again"
  }
};

export function RuntimeView({ snapshot, controller, onNavigate }: Props) {
  const { runtime, config, metrics, system } = snapshot;
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [command, setCommand] = useState<string[]>(runtime.command);
  const [checkouts, setCheckouts] = useState<DiscoveredCheckout[]>([]);
  const technicalRef = useRef<HTMLDetailsElement | null>(null);
  const reduceMotion = useReducedMotion();
  const latest = metrics.at(-1);
  const activeDownload = currentDownload(snapshot.downloads);
  const activeDownloadPercent = activeDownload
    ? Math.round((activeDownload.downloadedBytes / Math.max(activeDownload.totalBytes, 1)) * 100)
    : null;
  const qwenManaged = config.model.id === "qwen3.6-35b-a3b";
  const checkoutChangeAllowed = ["uninstalled", "idle", "error"].includes(runtime.phase) && !activeDownload;
  const phaseCopy = qwenManaged && runtime.phase === "running"
    ? { ...copyByPhase.running, description: "Qwen is ready for private chat and OpenAI-compatible agents with tools and streaming." }
    : qwenManaged && runtime.phase === "stopping"
      ? { ...copyByPhase.stopping, description: "Finishing active work before shutting down Qwen." }
      : copyByPhase[runtime.phase];
  const busy = Boolean(activeDownload) || busyPhases.includes(runtime.phase);
  const modelMissing = !runtime.modelPresent && runtime.phase !== "running" && !busy;
  const visibleCopy = activeDownload
    ? {
        title: "Downloading the model",
        description: `${formatBytes(activeDownload.downloadedBytes, 1)} of ${formatBytes(activeDownload.totalBytes, 1)}${activeDownload.speedBytesPerSecond > 0 ? ` · ${formatBytes(activeDownload.speedBytesPerSecond, 1)}/s` : ""}${formatDownloadEta(activeDownload.etaSeconds) ? ` · ${formatDownloadEta(activeDownload.etaSeconds)}` : ""}`,
        action: `${activeDownloadPercent}% complete`
      }
    : modelMissing
    ? {
        title: "Choose a model",
        description: "Use a GGUF file already on your Mac, or choose exactly what to download from the DSBox catalog.",
        action: "Choose model"
      }
    : phaseCopy;

  useEffect(() => {
    void apiRequest<CatalogResponse>("/api/models/catalog").then(setCatalog).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!technicalOpen) return;
    if (["starting", "running", "stopping"].includes(runtime.phase)) {
      setCommand(runtime.command);
    } else {
      void apiRequest<{ command: string[] }>("/api/runtime/command").then((value) => setCommand(value.command)).catch(() => undefined);
    }
    void apiRequest<{ checkouts: DiscoveredCheckout[] }>("/api/runtime/discover").then((value) => setCheckouts(value.checkouts)).catch(() => undefined);
  }, [config, runtime.command, runtime.gitHead, runtime.phase, technicalOpen]);

  useEffect(() => {
    if (!technicalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      technicalRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reduceMotion, technicalOpen]);

  const managedDefaultPath = `${config.repository.directory}/ds4flash.gguf`;
  const recommendedModel = catalog?.models.find((model) => model.recommended && (!model.runtimeBranch || model.runtimeBranch === config.repository.branch)) ?? null;
  const recommendedRepositoryName = recommendedModel?.repository.split("/").at(-1);
  const modelName = useMemo(() => {
    if (runtime.modelPresent) return formatModelName(config.model.id);
    return recommendedModel?.label || "No model selected";
  }, [config.model.id, recommendedModel, runtime.modelPresent]);

  const dsboxChoiceActive = recommendedModel
    ? config.model.id === recommendedModel.modelId && Boolean(recommendedRepositoryName && config.model.path.includes(`/models/${recommendedRepositoryName}/`))
    : config.model.id === "deepseek-v4-flash" && config.model.path === managedDefaultPath;
  const power = () => {
    if (busy) return;
    if (modelMissing) {
      onNavigate("models");
      return;
    }
    void controller.action(runtime.phase === "running" ? "Turning off DSBox" : "Turning on DSBox", "/api/runtime/power").catch(() => undefined);
  };

  const useCheckout = async (checkout: DiscoveredCheckout) => {
    if (!checkoutChangeAllowed) return;
    const next: DsboxConfig = {
      ...config,
      repository: { ...config.repository, directory: checkout.path, branch: checkout.branch ?? config.repository.branch },
      streaming: { ...config.streaming, enabled: true }
    };
    await controller.saveConfig(next);
  };

  const recentLogs = snapshot.logs.slice(-8);
  const displayedCommand = useMemo(() => {
    if (!qwenManaged || ["starting", "running", "stopping"].includes(runtime.phase) || command.length < 2) return command;
    const binaryIndex = command[0] === "DS4_QWEN_EXPERIMENTAL_METAL=1" ? 1 : 0;
    return command.map((value, index) => index === binaryIndex ? "<Qwen-capable DS4 checkout>/ds4-server" : value);
  }, [command, qwenManaged, runtime.phase]);
  const progress = activeDownload
    ? activeDownloadPercent!
    : runtime.phase === "preparing" ? 6
    : runtime.phase === "installing" || runtime.phase === "updating" ? 18
    : runtime.phase === "building" ? 38
      : runtime.phase === "downloading" ? 62
        : runtime.phase === "starting" ? 84
          : runtime.phase === "running" ? 100 : 0;

  return (
    <div className="server-page page-scroll">
      <section className={`power-panel panel power-panel--${activeDownload ? "downloading" : runtime.phase}`} aria-live="polite">
        <div className="power-panel__status"><StatusPill phase={activeDownload ? "downloading" : runtime.phase} /></div>
        <motion.button
          className={`power-control ${runtime.phase === "running" ? "power-control--on" : ""} ${busy ? "power-control--busy" : ""}`}
          onClick={power}
          disabled={busy}
          whileTap={busy ? undefined : { scale: 0.96 }}
          aria-label={visibleCopy.action}
        >
          <span className="power-control__ring" />
          <BrandMark size="hero" />
        </motion.button>
        <h2>{visibleCopy.title}</h2>
        <p>{visibleCopy.description}</p>
        <strong className="power-panel__action">{visibleCopy.action}</strong>
        {activeDownload && (
          <div className="simple-progress simple-progress--download" role="progressbar" aria-label="Model download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
        {busy && !activeDownload && runtime.phase !== "downloading" && (
          <div className="simple-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
        {activeDownload && (
          <Button
            variant="secondary"
            className="download-cancel"
            icon={<Pause size={15} />}
            onClick={() => void controller.action("Pausing download", `/api/models/downloads/${activeDownload.id}/cancel`, { removePartials: false }).catch(() => undefined)}
          >
            Pause download
          </Button>
        )}
        {!activeDownload && runtime.phase === "downloading" && (
          <>
            <div className="simple-progress simple-progress--indeterminate" role="progressbar" aria-label="Model download in progress"><span /></div>
            <Button variant="secondary" className="download-cancel" icon={<CircleStop size={15} />} onClick={() => void controller.action("Stopping download", "/api/runtime/cancel-task").catch(() => undefined)}>Stop download</Button>
          </>
        )}
        {runtime.phase === "error" && runtime.lastError && (
          <button className="error-detail-link" onClick={() => setTechnicalOpen(true)}>Show technical details</button>
        )}
      </section>

      <section className="automatic-card panel">
        <div className="automatic-card__head">
          <span className="automatic-icon"><ShieldCheck size={18} /></span>
          <div><h3>Automatic setup</h3><p>DSBox has already selected the right settings for this Mac.</p></div>
          <span className={dsboxChoiceActive ? "dsbox-recommended" : "chosen-by-user"}>{dsboxChoiceActive ? <><Check size={12} /> Recommended by DSBox</> : "Chosen by you"}</span>
        </div>
        <div className="automatic-facts">
          <div><span><Cpu size={15} /> This Mac</span><strong>{system.cpuModel.replace(/^Apple\s*/i, "")} · {formatBytes(system.totalMemoryBytes, 0)}</strong></div>
          <div><span><Gauge size={15} /> Model</span><strong>{modelName}</strong></div>
          <div><span><MemoryStick size={15} /> Memory</span><strong>Automatically balanced</strong></div>
          <div><span><ShieldCheck size={15} /> Privacy</span><strong>Stays on your Mac</strong></div>
        </div>
        <button className="automatic-card__settings" onClick={() => onNavigate("models")}>Change model <ExternalLink size={13} /></button>
      </section>

      {runtime.phase === "running" && (
        <section className="ready-actions">
          <button className="ready-action panel" onClick={() => onNavigate("chat")}><span><MessageSquareText size={19} /></span><div><strong>Open chat</strong><p>Start a private conversation.</p></div><ExternalLink size={14} /></button>
          {qwenManaged
            ? <button className="ready-action panel" onClick={() => onNavigate("agents")}><span><Bot size={19} /></span><div><strong>Connect an agent</strong><p>Chat Completions with tools.</p></div><ExternalLink size={14} /></button>
            : <button className="ready-action panel" onClick={() => onNavigate("agents")}><span><Bot size={19} /></span><div><strong>Connect an agent</strong><p>Codex, Claude Code, and others.</p></div><ExternalLink size={14} /></button>}
        </section>
      )}

      <section className="simple-metrics">
        <article className="panel"><span><MemoryStick size={16} /> Memory pressure</span><strong>{latest?.memoryPressurePercent === null || latest?.memoryPressurePercent === undefined ? "N/A" : `${Math.round(latest.memoryPressurePercent)}%`}</strong><small>{latest ? `${latest.memoryPressureLevel === "critical" ? "Critical" : latest.memoryPressureLevel === "warning" ? "Warning" : "Normal"} · ${formatBytes(latest.memoryUsedBytes)} committed` : "macOS cache tracked separately"}</small></article>
        <article className="panel"><span><Gauge size={16} /> Speed</span><strong>{latest?.tokensPerSecond ? `${latest.tokensPerSecond.toFixed(2)} t/s` : "—"}</strong><small>{runtime.phase === "running" ? "waiting for a response" : "DSBox is off"}</small></article>
        <article className="panel"><span><HardDrive size={16} /> Free space</span><strong>{latest ? formatBytes(latest.diskFreeBytes) : "—"}</strong><small>on the model drive</small></article>
        <article className="panel"><span><Clock3 size={16} /> Uptime</span><strong>{formatDuration(runtime.startedAt)}</strong><small>{runtime.phase === "running" ? "current session" : "—"}</small></article>
      </section>

      <details ref={technicalRef} className="technical-disclosure panel" open={technicalOpen} onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}>
        <summary><span><Wrench size={16} /> Technical details</span><ChevronDown size={15} /></summary>
        <div className="technical-content">
          <div className="technical-overview">
            <div><span>Channel</span><strong>{runtime.gitBranch ?? config.repository.branch}</strong></div>
            <div><span>Version</span><strong>{runtime.gitHead ?? "not installed"}</strong></div>
            <div><span>Mode</span><strong>{qwenManaged ? "Metal AUTO" : config.streaming.enabled ? "Metal + SSD streaming" : "Metal resident"}</strong></div>
            <div><span>Context</span><strong>{config.server.contextTokens.toLocaleString("en-US")} tokens</strong></div>
          </div>

          {checkouts.length > 0 && (
            <div className="technical-block">
              <h4><FolderGit2 size={14} /> DS4 installations found</h4>
              {!checkoutChangeAllowed && <p className="technical-empty">Turn off DSBox before changing the engine checkout.</p>}
              {checkouts.map((checkout) => (
                <div className="technical-checkout" key={checkout.path}>
                  <div><code>{checkout.path}</code><small>{checkout.branch} · {checkout.head}</small></div>
                  {checkout.path === config.repository.directory
                    ? <span><Check size={12} /> {checkoutChangeAllowed ? "Selected" : "In use"}</span>
                    : <button disabled={!checkoutChangeAllowed} title={checkoutChangeAllowed ? "Use this checkout" : "Turn off DSBox before changing checkout"} onClick={() => void useCheckout(checkout).catch(() => undefined)}>Use</button>}
                </div>
              ))}
            </div>
          )}

          <div className="technical-block">
            <div className="technical-block__head"><h4><Terminal size={14} /> {qwenManaged && !["starting", "running", "stopping"].includes(runtime.phase) ? "Startup profile" : "Startup command"}</h4><CopyButton value={displayedCommand.map(shellDisplayArgument).join(" ")} /></div>
            <pre><code>{displayedCommand.length ? displayedCommand.map(shellDisplayArgument).join(" ") : "Available after setup"}</code></pre>
          </div>

          <div className="technical-block">
            <h4><Terminal size={14} /> Recent events</h4>
            <div className="technical-logs">
              {recentLogs.length ? recentLogs.map((entry) => <div key={entry.id} className={`technical-log technical-log--${entry.level}`}><time>{timeLabel(entry.timestamp)}</time><span>{entry.source}</span><p>{entry.message}</p></div>) : <p className="technical-empty">No events yet.</p>}
            </div>
          </div>

          {runtime.phase === "stopping" && <Button variant="danger" icon={<AlertTriangle size={15} />} onClick={() => void controller.action("Force stop", "/api/runtime/force-stop").catch(() => undefined)}>Force stop</Button>}
        </div>
      </details>

    </div>
  );
}
