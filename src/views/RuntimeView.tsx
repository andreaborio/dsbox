import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Cpu,
  ExternalLink,
  FolderGit2,
  Gauge,
  HardDrive,
  MemoryStick,
  MessageSquareText,
  ShieldCheck,
  Terminal,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot, CatalogResponse, DsboxConfig, EnginePhase, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { apiRequest } from "../lib/api";
import { formatBytes, formatDuration, formatModelName, timeLabel } from "../lib/format";
import { Button, CopyButton, StatusPill } from "../components/ui";
import { DsboxOrb, type DsboxOrbState } from "../components/DsboxOrb";

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
    title: "DSBox è spento",
    description: "Accendilo e preparerò automaticamente tutto il necessario per questo Mac.",
    action: "Accendi DSBox"
  },
  idle: {
    title: "DSBox è spento",
    description: "Il modello e le impostazioni restano pronti. Accendilo quando vuoi usarlo.",
    action: "Accendi DSBox"
  },
  preparing: {
    title: "Sto preparando DSBox",
    description: "Scelgo il modello e le impostazioni corrette per questo Mac.",
    action: "Preparazione in corso"
  },
  installing: {
    title: "Sto preparando DSBox",
    description: "Configuro il motore per questo Mac. Questa operazione serve solo la prima volta.",
    action: "Preparazione in corso"
  },
  updating: {
    title: "Aggiorno DSBox",
    description: "Applico gli aggiornamenti senza toccare le tue modifiche locali.",
    action: "Aggiornamento in corso"
  },
  building: {
    title: "Ottimizzo per questo Mac",
    description: "Preparo il motore Metal usando le caratteristiche del tuo Apple Silicon.",
    action: "Ottimizzazione in corso"
  },
  downloading: {
    title: "Scarico il modello",
    description: "Se interrompi il download, riprenderà da dove era arrivato.",
    action: "Download in corso"
  },
  starting: {
    title: "Avvio il modello",
    description: "Il primo avvio può richiedere alcuni minuti. Ti avviserò appena sarà pronto.",
    action: "Accensione in corso"
  },
  running: {
    title: "DSBox è acceso",
    description: "Il modello è pronto per la chat e per i tuoi coding agent.",
    action: "Spegni"
  },
  stopping: {
    title: "Sto spegnendo DSBox",
    description: "Attendo il salvataggio del contesto prima di chiudere.",
    action: "Spegnimento in corso"
  },
  error: {
    title: "Non sono riuscito ad avviare DSBox",
    description: "Puoi riprovare. Il dettaglio tecnico è disponibile più in basso.",
    action: "Riprova"
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
  const phaseCopy = copyByPhase[runtime.phase];
  const busy = busyPhases.includes(runtime.phase);

  useEffect(() => {
    void apiRequest<CatalogResponse>("/api/models/catalog").then(setCatalog).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!technicalOpen) return;
    void apiRequest<{ command: string[] }>("/api/runtime/command").then((value) => setCommand(value.command)).catch(() => undefined);
    void apiRequest<{ checkouts: DiscoveredCheckout[] }>("/api/runtime/discover").then((value) => setCheckouts(value.checkouts)).catch(() => undefined);
  }, [config, runtime.gitHead, technicalOpen]);

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
    return recommendedModel?.label || "DeepSeek V4 Flash";
  }, [config.model.id, recommendedModel, runtime.modelPresent]);

  const dsboxChoiceActive = recommendedModel
    ? config.model.id === recommendedModel.modelId && Boolean(recommendedRepositoryName && config.model.path.includes(`/models/${recommendedRepositoryName}/`))
    : config.model.id === "deepseek-v4-flash" && config.model.path === managedDefaultPath;
  const orbState: DsboxOrbState = runtime.phase === "error"
    ? "error"
    : busy
      ? "preparing"
      : runtime.phase === "running"
        ? snapshot.activity.stage === "idle" ? "ready" : snapshot.activity.stage
        : "off";

  const power = () => {
    if (busy) return;
    void controller.action(runtime.phase === "running" ? "Spegnimento DSBox" : "Accensione DSBox", "/api/runtime/power").catch(() => undefined);
  };

  const useCheckout = async (checkout: DiscoveredCheckout) => {
    const glm = checkout.branch?.includes("glm52") ?? false;
    const next: DsboxConfig = {
      ...config,
      repository: { ...config.repository, directory: checkout.path, branch: checkout.branch ?? config.repository.branch },
      model: { path: `${checkout.path}/ds4flash.gguf`, id: glm ? "glm-5.2" : "deepseek-v4-flash" },
      streaming: { ...config.streaming, enabled: true }
    };
    await controller.saveConfig(next);
  };

  const recentLogs = snapshot.logs.slice(-8);
  const progress = runtime.phase === "preparing" ? 6
    : runtime.phase === "installing" || runtime.phase === "updating" ? 18
    : runtime.phase === "building" ? 38
      : runtime.phase === "downloading" ? 62
        : runtime.phase === "starting" ? 84
          : runtime.phase === "running" ? 100 : 0;

  return (
    <div className="server-page page-scroll">
      <section className={`power-panel panel power-panel--${runtime.phase}`} aria-live="polite">
        <div className="power-panel__status"><StatusPill phase={runtime.phase} /></div>
        <motion.button
          className={`power-control ${runtime.phase === "running" ? "power-control--on" : ""} ${busy ? "power-control--busy" : ""}`}
          onClick={power}
          disabled={busy}
          whileTap={busy ? undefined : { scale: 0.96 }}
          aria-label={phaseCopy.action}
        >
          <span className="power-control__ring" />
          <DsboxOrb state={orbState} size="hero" decorative />
        </motion.button>
        <h2>{phaseCopy.title}</h2>
        <p>{phaseCopy.description}</p>
        <strong className="power-panel__action">{phaseCopy.action}</strong>
        {busy && (
          <div className="simple-progress" role="progressbar" aria-label="Avanzamento preparazione" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
        {runtime.phase === "error" && runtime.lastError && (
          <button className="error-detail-link" onClick={() => setTechnicalOpen(true)}>Mostra dettagli tecnici</button>
        )}
      </section>

      <section className="automatic-card panel">
        <div className="automatic-card__head">
          <span className="automatic-icon"><ShieldCheck size={18} /></span>
          <div><h3>Automatico</h3><p>DSBox ha già scelto le impostazioni adatte a questo Mac.</p></div>
          <span className={dsboxChoiceActive ? "dsbox-recommended" : "chosen-by-user"}>{dsboxChoiceActive ? <><Check size={12} /> Consigliato da DSBox</> : "Scelto da te"}</span>
        </div>
        <div className="automatic-facts">
          <div><span><Cpu size={15} /> Questo Mac</span><strong>{system.cpuModel.replace(/^Apple\s*/i, "")} · {formatBytes(system.totalMemoryBytes, 0)}</strong></div>
          <div><span><Gauge size={15} /> Modello</span><strong>{modelName}</strong></div>
          <div><span><MemoryStick size={15} /> Memoria</span><strong>Bilanciata automaticamente</strong></div>
          <div><span><ShieldCheck size={15} /> Privacy</span><strong>Solo sul tuo Mac</strong></div>
        </div>
        <button className="automatic-card__settings" onClick={() => onNavigate("settings")}>Cambia modello o impostazioni <ExternalLink size={13} /></button>
      </section>

      {runtime.phase === "running" && (
        <section className="ready-actions">
          <button className="ready-action panel" onClick={() => onNavigate("chat")}><span><MessageSquareText size={19} /></span><div><strong>Apri la chat</strong><p>Inizia una conversazione privata.</p></div><ExternalLink size={14} /></button>
          <button className="ready-action panel" onClick={() => onNavigate("agents")}><span><Bot size={19} /></span><div><strong>Collega un agente</strong><p>Codex, Claude Code e altri.</p></div><ExternalLink size={14} /></button>
        </section>
      )}

      <section className="simple-metrics">
        <article className="panel"><span><MemoryStick size={16} /> Pressione memoria</span><strong>{latest?.memoryPressurePercent === null || latest?.memoryPressurePercent === undefined ? "N/D" : `${Math.round(latest.memoryPressurePercent)}%`}</strong><small>{latest ? `${latest.memoryPressureLevel === "critical" ? "Critica" : latest.memoryPressureLevel === "warning" ? "Attenzione" : "Normale"} · ${formatBytes(latest.memoryUsedBytes)} impegnati` : "cache macOS separata"}</small></article>
        <article className="panel"><span><Gauge size={16} /> Velocità</span><strong>{latest?.tokensPerSecond ? `${latest.tokensPerSecond.toFixed(2)} t/s` : "—"}</strong><small>{runtime.phase === "running" ? "in attesa di una risposta" : "DSBox spento"}</small></article>
        <article className="panel"><span><HardDrive size={16} /> Spazio libero</span><strong>{latest ? formatBytes(latest.diskFreeBytes) : "—"}</strong><small>sul disco del modello</small></article>
        <article className="panel"><span><Clock3 size={16} /> Attivo da</span><strong>{formatDuration(runtime.startedAt)}</strong><small>{runtime.phase === "running" ? "sessione corrente" : "—"}</small></article>
      </section>

      <details ref={technicalRef} className="technical-disclosure panel" open={technicalOpen} onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}>
        <summary><span><Wrench size={16} /> Dettagli tecnici</span><ChevronDown size={15} /></summary>
        <div className="technical-content">
          <div className="technical-overview">
            <div><span>Canale</span><strong>{runtime.gitBranch ?? config.repository.branch}</strong></div>
            <div><span>Versione</span><strong>{runtime.gitHead ?? "non installata"}</strong></div>
            <div><span>Modalità</span><strong>{config.streaming.enabled ? "Metal + SSD streaming" : "Metal resident"}</strong></div>
            <div><span>Contesto</span><strong>{config.server.contextTokens.toLocaleString("it-IT")} token</strong></div>
          </div>

          {checkouts.length > 0 && (
            <div className="technical-block">
              <h4><FolderGit2 size={14} /> Installazioni DS4 trovate</h4>
              {checkouts.map((checkout) => (
                <div className="technical-checkout" key={checkout.path}>
                  <div><code>{checkout.path}</code><small>{checkout.branch} · {checkout.head}</small></div>
                  {checkout.path === config.repository.directory ? <span><Check size={12} /> In uso</span> : <button onClick={() => void useCheckout(checkout).catch(() => undefined)}>Usa</button>}
                </div>
              ))}
            </div>
          )}

          <div className="technical-block">
            <div className="technical-block__head"><h4><Terminal size={14} /> Comando di avvio</h4><CopyButton value={command.join(" ")} /></div>
            <pre><code>{command.length ? command.map((value) => /\s/.test(value) ? `'${value}'` : value).join(" ") : "Disponibile dopo la configurazione"}</code></pre>
          </div>

          <div className="technical-block">
            <h4><Terminal size={14} /> Ultimi eventi</h4>
            <div className="technical-logs">
              {recentLogs.length ? recentLogs.map((entry) => <div key={entry.id} className={`technical-log technical-log--${entry.level}`}><time>{timeLabel(entry.timestamp)}</time><span>{entry.source}</span><p>{entry.message}</p></div>) : <p className="technical-empty">Nessun evento.</p>}
            </div>
          </div>

          {runtime.phase === "stopping" && <Button variant="danger" icon={<AlertTriangle size={15} />} onClick={() => void controller.action("Forza spegnimento", "/api/runtime/force-stop").catch(() => undefined)}>Forza spegnimento</Button>}
        </div>
      </details>

    </div>
  );
}
