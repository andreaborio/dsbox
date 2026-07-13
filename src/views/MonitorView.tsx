import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Info,
  MemoryStick,
  Search,
  Server,
  Terminal,
  Wrench,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import type { AppSnapshot, LogEntry, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { formatBytes, formatPercent, timeLabel } from "../lib/format";
import { Sparkline, StatusPill } from "../components/ui";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

type LogFilter = "all" | LogEntry["source"] | "warnings";

export function MonitorView({ snapshot }: Props) {
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [query, setQuery] = useState("");
  const { metrics, runtime, logs, config } = snapshot;
  const latest = metrics.at(-1);
  const memoryValues = metrics.map((sample) => sample.memoryTotalBytes ? (sample.memoryUsedBytes / sample.memoryTotalBytes) * 100 : 0);
  const cpuValues = metrics.map((sample) => sample.systemCpuPercent);
  const tokenValues = metrics.map((sample) => sample.tokensPerSecond ?? 0);

  const filteredLogs = useMemo(() => logs.filter((entry) => {
    const matchesFilter = logFilter === "all"
      || (logFilter === "warnings" ? ["warn", "error"].includes(entry.level) : entry.source === logFilter);
    return matchesFilter && (!query || entry.message.toLowerCase().includes(query.toLowerCase()));
  }).slice(-300), [logFilter, logs, query]);

  const memoryPercent = latest && latest.memoryTotalBytes ? (latest.memoryUsedBytes / latest.memoryTotalBytes) * 100 : 0;
  const diskUsedPercent = latest && latest.diskTotalBytes ? ((latest.diskTotalBytes - latest.diskFreeBytes) / latest.diskTotalBytes) * 100 : 0;
  const pressure = latest?.memoryPressurePercent;
  const memoryWarning = latest?.memoryPressureLevel ? latest.memoryPressureLevel !== "normal" : pressure !== null && pressure !== undefined ? pressure > 65 : memoryPercent > 90;
  const fileCachePercent = latest?.memoryTotalBytes ? latest.memoryFileCacheBytes / latest.memoryTotalBytes * 100 : 0;

  return (
    <div className="monitor-page page-scroll">
      <section className="monitor-summary">
        <div>
          <span className="eyebrow"><Activity size={13} /> Aggiornamento in tempo reale</span>
          <h2>Cosa sta usando DSBox.</h2>
          <p>Memoria, CPU, spazio su disco e velocità del modello, senza stime inventate.</p>
        </div>
        <div className="monitor-summary__status panel">
          <StatusPill phase={runtime.phase} />
          <div><small>Processo</small><strong>{runtime.pid ?? "—"}</strong></div>
          <div><small>Motore</small><strong>Metal</strong></div>
          <div><small>Stato modello</small><strong>{snapshot.activity.stage === "idle" ? "In attesa" : snapshot.activity.stage === "prefill" ? "Prefill" : snapshot.activity.stage === "thinking" ? "Thinking" : "Decode"}</strong></div>
        </div>
      </section>

      <section className="monitor-cards">
        <article className="resource-card panel">
          <div className="resource-card__head"><span><MemoryStick size={17} /></span><div><small>Memoria unificata</small><strong>{latest ? formatBytes(latest.memoryUsedBytes) : "—"}<em> / {latest ? formatBytes(latest.memoryTotalBytes) : "—"}</em></strong></div><b>{formatPercent(memoryPercent)}</b></div>
          <Sparkline values={memoryValues} max={100} color="#6658d3" height={74} />
          <div className="resource-card__foot"><span>Pressione {pressure === null || pressure === undefined ? "N/D" : formatPercent(pressure)}</span><span>Cache riutilizzabile {latest ? formatBytes(latest.memoryFileCacheBytes) : "—"}</span></div>
        </article>
        <article className="resource-card panel">
          <div className="resource-card__head"><span><Cpu size={17} /></span><div><small>CPU sistema</small><strong>{latest ? formatPercent(latest.systemCpuPercent, 1) : "—"}</strong></div></div>
          <Sparkline values={cpuValues} max={100} color="#1e8b68" />
          <div className="resource-card__foot"><span>DS4 {latest && runtime.pid ? formatPercent(latest.processCpuPercent, 1) : "—"}</span><span>Load {latest?.loadAverage.toFixed(2) ?? "—"}</span></div>
        </article>
        <article className="resource-card panel">
          <div className="resource-card__head"><span><Gauge size={17} /></span><div><small>Velocità risposta</small><strong>{latest?.tokensPerSecond ? `${latest.tokensPerSecond.toFixed(2)} t/s` : "In attesa"}</strong></div></div>
          <Sparkline values={tokenValues} color="#d17832" />
          <div className="resource-card__foot"><span>Misurata da DSBox</span><span>non stimata</span></div>
        </article>
        <article className="resource-card panel">
          <div className="resource-card__head"><span><HardDrive size={17} /></span><div><small>Spazio libero</small><strong>{latest ? formatBytes(latest.diskFreeBytes, 0) : "—"}</strong></div></div>
          <div className="disk-usage-line"><span style={{ width: `${Math.min(100, diskUsedPercent)}%` }} /></div>
          <div className="resource-card__foot"><span>Disco del modello</span><span>{latest ? `${formatPercent(diskUsedPercent)} usato` : "—"}</span></div>
        </article>
      </section>

      <details className="monitor-technical panel">
        <summary><span><Wrench size={17} /><span><strong>Dettagli tecnici</strong><small>Swap, cache, Metal e log diagnostici</small></span></span><ChevronDown size={16} /></summary>
        <div className="monitor-technical__content">
      <section className="monitor-detail-grid">
        <article className="panel memory-breakdown">
          <div className="panel-heading"><div><span className="eyebrow">Memoria macOS</span><h3>Pressione e swap</h3></div><Database size={17} /></div>
          <div className="memory-bars">
            <div>
              <span><i className="legend-dot legend-dot--ram" />RAM utilizzata <strong>{formatPercent(memoryPercent)}</strong></span>
              <div className="progress-bar"><i style={{ width: `${Math.min(100, memoryPercent)}%` }} /></div>
              <small>{latest ? `${formatBytes(latest.memoryUsedBytes)} di ${formatBytes(latest.memoryTotalBytes)}` : "Nessun sample"}</small>
            </div>
            <div>
              <span><i className="legend-dot legend-dot--process" />Processo ds4 <strong>{latest && runtime.pid ? formatBytes(latest.processRssBytes) : "—"}</strong></span>
              <div className="progress-bar progress-bar--process"><i style={{ width: `${latest && latest.memoryTotalBytes ? Math.min(100, latest.processRssBytes / latest.memoryTotalBytes * 100) : 0}%` }} /></div>
              <small>RSS del child process, non memoria Metal allocata</small>
            </div>
            <div>
              <span><i className="legend-dot legend-dot--swap" />Swap macOS <strong>{latest ? formatBytes(latest.swapUsedBytes) : "—"}</strong></span>
              <div className="progress-bar progress-bar--swap"><i style={{ width: `${latest?.swapTotalBytes ? Math.min(100, latest.swapUsedBytes / latest.swapTotalBytes * 100) : 0}%` }} /></div>
              <small>{latest?.swapTotalBytes ? `${formatBytes(latest.swapUsedBytes)} di ${formatBytes(latest.swapTotalBytes)}` : "Nessuno swap allocato"}</small>
            </div>
            <div>
              <span><i className="legend-dot legend-dot--cache" />Cache file riutilizzabile <strong>{latest ? formatBytes(latest.memoryFileCacheBytes) : "—"}</strong></span>
              <div className="progress-bar progress-bar--cache"><i style={{ width: `${Math.min(100, fileCachePercent)}%` }} /></div>
              <small>Può contenere file e pesi mmap; macOS la recupera quando serve.</small>
            </div>
          </div>
          <div className={`health-callout ${memoryWarning ? "health-callout--warn" : ""}`}>
            {memoryWarning ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <p>{memoryWarning ? "Pressione memoria alta: riduci la conversazione o la cache del modello prima di riavviare." : "Pressione memoria normale. La cache riutilizzabile di macOS non viene contata come memoria occupata."}</p>
          </div>
        </article>

        <article className="panel io-panel">
          <div className="panel-heading"><div><span className="eyebrow">Archiviazione</span><h3>SSD e contesto</h3></div><HardDrive size={17} /></div>
          <div className="disk-donut" style={{ "--disk": `${diskUsedPercent * 3.6}deg` } as React.CSSProperties}>
            <div><strong>{latest ? formatBytes(latest.diskFreeBytes, 0) : "—"}</strong><span>liberi</span></div>
          </div>
          <div className="io-facts">
            <div><span>Volume</span><strong>{latest ? formatBytes(latest.diskTotalBytes, 0) : "—"}</strong></div>
            <div><span>Cache modello</span><strong>{config.streaming.cacheMode === "auto" ? "Adattiva" : `${config.streaming.cacheSizeGb} GB`}</strong></div>
            <div><span>Contesto su disco</span><strong>{config.kvCache.enabled ? formatBytes(config.kvCache.spaceMb * 1024 ** 2, 0) : "Off"}</strong></div>
            <div><span>Modalità</span><strong>{config.streaming.enabled ? "Streaming SSD" : "In memoria"}</strong></div>
          </div>
          <p className="metric-disclaimer"><Info size={13} /> La velocità SSD del singolo processo non è esposta in modo affidabile da macOS senza strumentazione interna.</p>
        </article>

        <article className="panel metal-panel">
          <div className="panel-heading"><div><span className="eyebrow">Apple GPU</span><h3>Metal</h3></div><Server size={17} /></div>
          <div className="na-metric"><span>N/D</span><p>Utilizzo GPU</p></div>
          <div className="metal-facts">
            <div><Circle size={8} fill="currentColor" /><span>Motore</span><strong>Metal</strong></div>
            <div><Circle size={8} fill="currentColor" /><span>Architettura</span><strong>{snapshot.system.arch}</strong></div>
            <div><Circle size={8} fill="currentColor" /><span>Memoria</span><strong>Unificata</strong></div>
          </div>
          <div className="metal-note"><Info size={14} /><p><code>powermetrics</code> richiede privilegi. DSBox non chiede sudo e non mostra percentuali inventate.</p></div>
        </article>
      </section>

      <section className="panel logs-panel">
        <div className="logs-toolbar">
          <div><span className="eyebrow"><Terminal size={13} /> Diagnostica</span><h3>Eventi runtime</h3></div>
          <div className="logs-toolbar__controls">
            <label className="log-search"><Search size={14} /><input aria-label="Cerca negli eventi runtime" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca nei log" />{query && <button onClick={() => setQuery("")} aria-label="Cancella ricerca"><X size={13} /></button>}</label>
            <label className="log-filter"><select aria-label="Filtra gli eventi per fonte" value={logFilter} onChange={(event) => setLogFilter(event.target.value as LogFilter)}><option value="all">Tutte le fonti</option><option value="ds4">ds4</option><option value="dsbox">dsbox</option><option value="build">build</option><option value="git">git</option><option value="download">download</option><option value="warnings">Avvisi + errori</option></select><ChevronDown size={13} /></label>
          </div>
        </div>
        <div className="terminal-window">
          <div className="terminal-window__head"><i /><i /><i /><span>{filteredLogs.length} righe · buffer max 1.200</span></div>
          <div className="terminal-window__body">
            {filteredLogs.length ? filteredLogs.map((entry) => (
              <div className={`terminal-line terminal-line--${entry.level}`} key={entry.id}>
                <time>{timeLabel(entry.timestamp)}</time><span className="terminal-line__source">{entry.source.padEnd(8)}</span><span className="terminal-line__marker">{entry.level === "error" ? "×" : entry.level === "warn" ? "!" : entry.level === "success" ? "✓" : "·"}</span><p>{entry.message}</p>
              </div>
            )) : <div className="terminal-empty">Nessuna riga corrisponde al filtro.</div>}
          </div>
        </div>
        {config.observability.traceEnabled && <div className="trace-warning"><AlertTriangle size={14} /><p>Trace attiva: ds4 può salvare prompt, output e tool call in chiaro.</p></div>}
      </section>
        </div>
      </details>
    </div>
  );
}
