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
import { argumentOptionValue, tokenizeArguments } from "../lib/arguments";
import { formatBytes, formatPercent, timeLabel } from "../lib/format";
import { Sparkline, StatusPill } from "../components/ui";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

type LogFilter = "all" | LogEntry["source"] | "warnings";

function cacheLabel(value: string): string {
  if (value.toUpperCase().endsWith("GB")) return value;
  const experts = Number(value);
  return Number.isFinite(experts) ? `${experts.toLocaleString("en-US")} experts` : value;
}

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
  const liveTokensPerSecond = snapshot.activity.stage === "idle" ? null : latest?.tokensPerSecond ?? null;
  const runtimeActive = ["starting", "running", "stopping"].includes(runtime.phase);
  const runtimeCache = runtimeActive
    ? argumentOptionValue(runtime.command, "--ssd-streaming-cache-experts")
    : null;
  const runtimeStreaming = runtimeActive && runtime.command.includes("--ssd-streaming");
  let configuredCacheOverride: string | null = null;
  try {
    configuredCacheOverride = argumentOptionValue(
      tokenizeArguments(config.advanced.extraArgs),
      "--ssd-streaming-cache-experts"
    );
  } catch {
    // Invalid advanced arguments are reported when the user tries to start.
  }
  const modelCacheLabel = runtimeActive
    ? !runtimeStreaming
      ? "Not used"
      : runtimeCache
        ? cacheLabel(runtimeCache)
        : "Adaptive · DS4"
    : configuredCacheOverride
      ? cacheLabel(configuredCacheOverride)
      : config.streaming.cacheMode === "auto"
        ? "Adaptive · DS4"
        : `${config.streaming.cacheSizeGb} GB`;

  return (
    <div className="monitor-page page-scroll">
      <section className="monitor-summary">
        <div>
          <span className="eyebrow"><Activity size={13} /> Real-time updates</span>
          <h2>What DSBox is using.</h2>
          <p>Memory, CPU, disk space, and model speed, with no fabricated estimates.</p>
        </div>
        <div className="monitor-summary__status panel">
          <StatusPill phase={runtime.phase} />
          <div><small>Process</small><strong>{runtime.pid ?? "—"}</strong></div>
          <div><small>Engine</small><strong>Metal</strong></div>
          <div><small>Model status</small><strong>{snapshot.activity.stage === "idle" ? "Waiting" : snapshot.activity.stage === "prefill" ? "Prefill" : snapshot.activity.stage === "thinking" ? "Thinking" : "Decode"}</strong></div>
        </div>
      </section>

      <section className="monitor-cards">
        <article className="resource-card panel">
          <div className="resource-card__head"><span><MemoryStick size={17} /></span><div><small>Committed memory</small><strong>{latest ? formatBytes(latest.memoryUsedBytes) : "—"}<em> / {latest ? formatBytes(latest.memoryTotalBytes) : "—"}</em></strong></div><b>{formatPercent(memoryPercent)}</b></div>
          <Sparkline values={memoryValues} max={100} color="#6658d3" height={74} />
          <div className="resource-card__foot"><span>Pressure {pressure === null || pressure === undefined ? "N/A" : formatPercent(pressure)}</span><span>Cache {latest ? formatBytes(latest.memoryFileCacheBytes) : "—"}</span></div>
        </article>
        <article className="resource-card panel">
          <div className="resource-card__head"><span><Cpu size={17} /></span><div><small>System CPU</small><strong>{latest ? formatPercent(latest.systemCpuPercent, 1) : "—"}</strong></div></div>
          <Sparkline values={cpuValues} max={100} color="#1e8b68" />
          <div className="resource-card__foot"><span>DS4 {latest && runtime.pid ? formatPercent(latest.processCpuPercent, 1) : "—"}</span><span>Load {latest?.loadAverage.toFixed(2) ?? "—"}</span></div>
        </article>
        <article className="resource-card panel">
          <div className="resource-card__head"><span><Gauge size={17} /></span><div><small>Response speed</small><strong>{liveTokensPerSecond !== null ? `${liveTokensPerSecond.toFixed(2)} t/s` : "Waiting"}</strong></div></div>
          <Sparkline values={tokenValues} color="#d17832" />
          <div className="resource-card__foot"><span>Measured by DSBox</span><span>not estimated</span></div>
        </article>
        <article className="resource-card panel">
          <div className="resource-card__head"><span><HardDrive size={17} /></span><div><small>Free space</small><strong>{latest ? formatBytes(latest.diskFreeBytes, 0) : "—"}</strong></div></div>
          <div className="disk-usage-line"><span style={{ width: `${Math.min(100, diskUsedPercent)}%` }} /></div>
          <div className="resource-card__foot"><span>Model volume</span><span>{latest ? `${formatPercent(diskUsedPercent)} used` : "—"}</span></div>
        </article>
      </section>

      <details className="monitor-technical panel">
        <summary><span><Wrench size={17} /><span><strong>Technical details</strong><small>Swap, cache, Metal, and diagnostic logs</small></span></span><ChevronDown size={16} /></summary>
        <div className="monitor-technical__content">
      <section className="monitor-detail-grid">
        <article className="panel memory-breakdown">
          <div className="panel-heading"><div><span className="eyebrow">macOS memory</span><h3>Pressure and swap</h3></div><Database size={17} /></div>
          <div className="memory-bars">
            <div>
              <span><i className="legend-dot legend-dot--ram" />Committed memory <strong>{formatPercent(memoryPercent)}</strong></span>
              <div className="progress-bar"><i style={{ width: `${Math.min(100, memoryPercent)}%` }} /></div>
              <small>{latest ? `${formatBytes(latest.memoryUsedBytes)} of ${formatBytes(latest.memoryTotalBytes)}` : "No samples"}</small>
            </div>
            <div>
              <span><i className="legend-dot legend-dot--process" />ds4 process <strong>{latest && runtime.pid ? formatBytes(latest.processRssBytes) : "—"}</strong></span>
              <div className="progress-bar progress-bar--process"><i style={{ width: `${latest && latest.memoryTotalBytes ? Math.min(100, latest.processRssBytes / latest.memoryTotalBytes * 100) : 0}%` }} /></div>
              <small>Child process RSS, not allocated Metal memory</small>
            </div>
            <div>
              <span><i className="legend-dot legend-dot--swap" />Swap macOS <strong>{latest ? formatBytes(latest.swapUsedBytes) : "—"}</strong></span>
              <div className="progress-bar progress-bar--swap"><i style={{ width: `${latest?.swapTotalBytes ? Math.min(100, latest.swapUsedBytes / latest.swapTotalBytes * 100) : 0}%` }} /></div>
              <small>{latest?.swapTotalBytes ? `${formatBytes(latest.swapUsedBytes)} of ${formatBytes(latest.swapTotalBytes)}` : "No swap allocated"}</small>
            </div>
            <div>
              <span><i className="legend-dot legend-dot--cache" />Reclaimable file cache <strong>{latest ? formatBytes(latest.memoryFileCacheBytes) : "—"}</strong></span>
              <div className="progress-bar progress-bar--cache"><i style={{ width: `${Math.min(100, fileCachePercent)}%` }} /></div>
              <small>May include files and mmap weights; macOS reclaims it when needed.</small>
            </div>
          </div>
          <div className={`health-callout ${memoryWarning ? "health-callout--warn" : ""}`}>
            {memoryWarning ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <p>{memoryWarning ? "High memory pressure: shorten the conversation or reduce the model cache before restarting." : "Memory pressure is normal. Reclaimable macOS cache is not counted as occupied memory."}</p>
          </div>
        </article>

        <article className="panel io-panel">
          <div className="panel-heading"><div><span className="eyebrow">Storage</span><h3>SSD and context</h3></div><HardDrive size={17} /></div>
          <div className="disk-donut" style={{ "--disk": `${diskUsedPercent * 3.6}deg` } as React.CSSProperties}>
            <div><strong>{latest ? formatBytes(latest.diskFreeBytes, 0) : "—"}</strong><span>free</span></div>
          </div>
          <div className="io-facts">
            <div><span>Volume</span><strong>{latest ? formatBytes(latest.diskTotalBytes, 0) : "—"}</strong></div>
            <div><span>Model cache</span><strong>{modelCacheLabel}</strong></div>
            <div><span>On-disk context</span><strong>{config.kvCache.enabled ? formatBytes(config.kvCache.spaceMb * 1024 ** 2, 0) : "Off"}</strong></div>
            <div><span>Mode</span><strong>{(runtimeActive ? runtimeStreaming : config.streaming.enabled) ? "SSD streaming" : "In memory"}</strong></div>
          </div>
          <p className="metric-disclaimer"><Info size={13} /> macOS does not reliably expose per-process SSD throughput without internal instrumentation.</p>
        </article>

        <article className="panel metal-panel">
          <div className="panel-heading"><div><span className="eyebrow">Apple GPU</span><h3>Metal</h3></div><Server size={17} /></div>
          <div className="na-metric"><span>N/A</span><p>GPU usage</p></div>
          <div className="metal-facts">
            <div><Circle size={8} fill="currentColor" /><span>Engine</span><strong>Metal</strong></div>
            <div><Circle size={8} fill="currentColor" /><span>Architecture</span><strong>{snapshot.system.arch}</strong></div>
            <div><Circle size={8} fill="currentColor" /><span>Memory</span><strong>Unified</strong></div>
          </div>
          <div className="metal-note"><Info size={14} /><p><code>powermetrics</code> requires elevated privileges. DSBox does not request sudo access or display fabricated percentages.</p></div>
        </article>
      </section>

      <section className="panel logs-panel">
        <div className="logs-toolbar">
          <div><span className="eyebrow"><Terminal size={13} /> Diagnostics</span><h3>Runtime events</h3></div>
          <div className="logs-toolbar__controls">
            <label className="log-search"><Search size={14} /><input aria-label="Search runtime events" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search logs" />{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button>}</label>
            <label className="log-filter"><select aria-label="Filter events by source" value={logFilter} onChange={(event) => setLogFilter(event.target.value as LogFilter)}><option value="all">All sources</option><option value="ds4">ds4</option><option value="dsbox">dsbox</option><option value="build">build</option><option value="git">git</option><option value="download">download</option><option value="warnings">Warnings + errors</option></select><ChevronDown size={13} /></label>
          </div>
        </div>
        <div className="terminal-window">
          <div className="terminal-window__head"><i /><i /><i /><span>{filteredLogs.length} lines · 1,200 max buffer</span></div>
          <div className="terminal-window__body">
            {filteredLogs.length ? filteredLogs.map((entry) => (
              <div className={`terminal-line terminal-line--${entry.level}`} key={entry.id}>
                <time>{timeLabel(entry.timestamp)}</time><span className="terminal-line__source">{entry.source.padEnd(8)}</span><span className="terminal-line__marker">{entry.level === "error" ? "×" : entry.level === "warn" ? "!" : entry.level === "success" ? "✓" : "·"}</span><p>{entry.message}</p>
              </div>
            )) : <div className="terminal-empty">No lines match this filter.</div>}
          </div>
        </div>
        {config.observability.traceEnabled && <div className="trace-warning"><AlertTriangle size={14} /><p>Tracing enabled: ds4 may save prompts, outputs, and tool calls as plain text.</p></div>}
      </section>
        </div>
      </details>
    </div>
  );
}
