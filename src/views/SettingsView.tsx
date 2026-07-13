import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Code2,
  Database,
  Eye,
  EyeOff,
  FolderGit2,
  HardDrive,
  KeyRound,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, CopyButton, Field, Select, Toggle } from "../components/ui";
import type { DsboxController } from "../hooks/useDsbox";
import { formatModelName } from "../lib/format";
import type { AppSnapshot, DsboxConfig, ViewId } from "../types";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

const conversationPresets = [
  { value: 8_192, label: "Compact · 8K" },
  { value: 16_384, label: "Efficient · 16K" },
  { value: 32_768, label: "Standard · 32K" },
  { value: 65_536, label: "Long · 64K" },
  { value: 100_000, label: "Very long · 100K" }
] as const;

const responsePresets = [
  { value: 4_096, label: "Compact · 4K" },
  { value: 8_192, label: "Standard · 8K" },
  { value: 16_384, label: "Long · 16K" },
  { value: 32_768, label: "Very long · 32K" }
] as const;

const engineBranches = [
  { value: "main", label: "DeepSeek · Stable" },
  { value: "codex/glm52-upstream-clean-bench", label: "GLM 5.2 · Experimental" }
] as const;

function cloneConfig(config: DsboxConfig): DsboxConfig {
  return structuredClone(config);
}

export function SettingsView({ snapshot, controller, onNavigate }: Props) {
  const [draft, setDraft] = useState(() => cloneConfig(snapshot.config));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(cloneConfig(snapshot.config));
  }, [snapshot.config]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(snapshot.config), [draft, snapshot.config]);
  const runtimeActive = ["running", "starting"].includes(snapshot.runtime.phase);
  const unifiedMemoryGb = snapshot.system.totalMemoryBytes / 1024 ** 3;
  const manualCacheMaxGb = Math.min(128, Math.max(8, Math.floor((unifiedMemoryGb * 0.75) / 4) * 4));

  const update = <K extends keyof DsboxConfig>(section: K, value: DsboxConfig[K]) => {
    setDraft((current) => ({ ...current, [section]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      await controller.saveConfig(draft);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  const commandPreview = useMemo(() => {
    const parts = [
      `${draft.repository.directory}/ds4-server`,
      "--metal", "-m", draft.model.path,
      "--ctx", String(draft.server.contextTokens),
      "--tokens", String(draft.server.maxOutputTokens),
      "--power", String(draft.server.powerPercent),
      "--host", "127.0.0.1", "--port", String(draft.server.internalPort)
    ];
    if (draft.streaming.enabled) {
      parts.push("--ssd-streaming");
      if (draft.streaming.cacheMode === "manual") parts.push("--ssd-streaming-cache-experts", `${draft.streaming.cacheSizeGb}GB`);
    }
    if (draft.kvCache.enabled) parts.push("--kv-disk-dir", draft.kvCache.directory, "--kv-disk-space-mb", String(draft.kvCache.spaceMb));
    if (draft.server.prefillChunk) parts.push("--prefill-chunk", String(draft.server.prefillChunk));
    if (draft.server.quality) parts.push("--quality");
    if (draft.server.warmWeights) parts.push("--warm-weights");
    return parts.map((value) => /\s/.test(value) ? `'${value}'` : value).join(" ");
  }, [draft]);

  return (
    <div className="settings-simple page-scroll">
      <div className="settings-simple__inner">
        <div className="settings-context">
          <div><span className="eyebrow">Current model</span><strong>{formatModelName(snapshot.config.model.id)}</strong><p>Model discovery and downloads live in one dedicated place.</p></div>
          <Button variant="secondary" onClick={() => onNavigate("models")}>Manage models</Button>
        </div>

        <section className="settings-simple-card panel" aria-labelledby="conversation-settings-title">
          <div className="settings-simple-card__head"><div><h2 id="conversation-settings-title">Conversation</h2><p>Longer memory and answers use more of your Mac's memory.</p></div><SlidersHorizontal size={17} /></div>
          <div className="form-grid settings-simple-grid">
            <Field label="Conversation memory"><Select value={draft.server.contextTokens} onChange={(event) => update("server", { ...draft.server, contextTokens: Number(event.target.value) })}>{!conversationPresets.some((preset) => preset.value === draft.server.contextTokens) && <option value={draft.server.contextTokens}>Custom · {draft.server.contextTokens.toLocaleString("en-US")}</option>}{conversationPresets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</Select></Field>
            <Field label="Answer length"><Select value={draft.server.maxOutputTokens} onChange={(event) => update("server", { ...draft.server, maxOutputTokens: Number(event.target.value) })}>{!responsePresets.some((preset) => preset.value === draft.server.maxOutputTokens) && <option value={draft.server.maxOutputTokens}>Custom · {draft.server.maxOutputTokens.toLocaleString("en-US")}</option>}{responsePresets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</Select></Field>
          </div>
          <div className="setting-row"><div><strong>Best quality</strong><p>Prefer precision even when an answer takes a little longer.</p></div><Toggle checked={draft.server.quality} onChange={(quality) => update("server", { ...draft.server, quality })} label="Best quality" /></div>
        </section>

        <section className="settings-simple-card panel" aria-labelledby="privacy-settings-title">
          <div className="settings-simple-card__head"><div><h2 id="privacy-settings-title">Privacy & data</h2><p>Everything below stays in your user folder. Nothing is uploaded by DSBox.</p></div><ShieldCheck size={17} /></div>
          <div className="setting-row">
            <span className="setting-row__icon setting-row__icon--green"><Database size={18} /></span>
            <div><strong>Reuse context between sessions</strong><p>Keeps part of long conversations on disk so agents restart faster. It may contain prompt text.</p></div>
            <Toggle checked={draft.kvCache.enabled} onChange={(enabled) => update("kvCache", { ...draft.kvCache, enabled })} label="Reuse context between sessions" />
          </div>
          {draft.kvCache.enabled && (
            <div className="nested-settings form-grid">
              <Field label="Context folder" className="form-grid--full"><input value={draft.kvCache.directory} onChange={(event) => update("kvCache", { ...draft.kvCache, directory: event.target.value })} /></Field>
              <Field label="Maximum disk space (MB)"><input type="number" min={1} value={draft.kvCache.spaceMb} onChange={(event) => update("kvCache", { ...draft.kvCache, spaceMb: Number(event.target.value) })} /></Field>
              <Field label="Minimum length (tokens)"><input type="number" min={0} value={draft.kvCache.minTokens} onChange={(event) => update("kvCache", { ...draft.kvCache, minTokens: Number(event.target.value) })} /></Field>
              <Field label="Save interval (tokens)" className="form-grid--full"><input type="number" min={0} value={draft.kvCache.continuedIntervalTokens} onChange={(event) => update("kvCache", { ...draft.kvCache, continuedIntervalTokens: Number(event.target.value) })} /></Field>
            </div>
          )}
          <div className="privacy-note"><ShieldCheck size={15} /><p>Context data is stored locally and may include parts of your prompts. Review it before sharing.</p></div>
        </section>

        <section className={`settings-advanced panel ${advancedOpen ? "settings-advanced--open" : ""}`}>
          <button className="settings-advanced__toggle" onClick={() => setAdvancedOpen((value) => !value)} aria-expanded={advancedOpen} aria-controls="advanced-settings-content">
            <span><Code2 size={17} /><span><strong>Advanced</strong><small>Engine channel, Metal, flags, diagnostics, API key, and launch command</small></span></span>
            <ChevronDown size={17} />
          </button>
          <AnimatePresence initial={false}>
            {advancedOpen && (
              <motion.div id="advanced-settings-content" className="settings-advanced__content" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}>
                <div className="advanced-group">
                  <div className="advanced-group__head"><div><h3>Performance</h3><p>DSBox defaults are tuned for SSD streaming on this Mac.</p></div><Zap size={16} /></div>
                  <div className="setting-row"><span className="setting-row__icon"><HardDrive size={17} /></span><div><strong>Optimized SSD streaming</strong><p>Loads the useful parts of the model into memory and streams the rest when needed.</p></div><Toggle checked={draft.streaming.enabled} onChange={(enabled) => update("streaming", { ...draft.streaming, enabled })} label="Optimized SSD streaming" /></div>
                  {draft.streaming.enabled && <div className="nested-settings"><div className="segmented-control"><button className={draft.streaming.cacheMode === "auto" ? "active" : ""} aria-pressed={draft.streaming.cacheMode === "auto"} onClick={() => update("streaming", { ...draft.streaming, cacheMode: "auto" })}>Adaptive</button><button className={draft.streaming.cacheMode === "manual" ? "active" : ""} aria-pressed={draft.streaming.cacheMode === "manual"} onClick={() => update("streaming", { ...draft.streaming, cacheMode: "manual" })}>Custom</button></div>{draft.streaming.cacheMode === "manual" && <Field label="Expert cache budget" hint={`${draft.streaming.cacheSizeGb} GB · DS4 applies a safe cap`}><div className="range-field"><input aria-label="Expert cache budget" type="range" min={8} max={manualCacheMaxGb} step={4} value={Math.min(draft.streaming.cacheSizeGb, manualCacheMaxGb)} onChange={(event) => update("streaming", { ...draft.streaming, cacheSizeGb: Number(event.target.value) })} /><input aria-label="Expert cache budget in GB" type="number" min={1} max={manualCacheMaxGb} value={draft.streaming.cacheSizeGb} onChange={(event) => update("streaming", { ...draft.streaming, cacheSizeGb: Number(event.target.value) })} /><span>GB</span></div></Field>}</div>}
                </div>

                <div className="advanced-group">
                  <div className="advanced-group__head"><div><h3>DS4 engine</h3><p>The andreaborio/ds4 fork and its local checkout.</p></div><FolderGit2 size={16} /></div>
                  <div className="form-grid">
                    <Field label="Repository" hint="HTTPS only" className="form-grid--full"><input value={draft.repository.url} onChange={(event) => update("repository", { ...draft.repository, url: event.target.value })} /></Field>
                    <Field label="Engine channel"><Select value={draft.repository.branch} onChange={(event) => update("repository", { ...draft.repository, branch: event.target.value })}>{!engineBranches.some((branch) => branch.value === draft.repository.branch) && <option value={draft.repository.branch}>Current · {draft.repository.branch}</option>}{engineBranches.map((branch) => <option key={branch.value} value={branch.value}>{branch.label}</option>)}</Select></Field>
                    <Field label="Private port"><input type="number" min={1024} max={65535} value={draft.server.internalPort} onChange={(event) => update("server", { ...draft.server, internalPort: Number(event.target.value) })} /></Field>
                    <Field label="Engine folder" className="form-grid--full"><input value={draft.repository.directory} onChange={(event) => update("repository", { ...draft.repository, directory: event.target.value })} /></Field>
                  </div>
                  <div className="privacy-note"><ShieldCheck size={15} /><p>The internal server remains bound to 127.0.0.1.</p></div>
                </div>

                <div className="advanced-group">
                  <div className="advanced-group__head"><div><h3>Engine parameters</h3><p>Technical controls for benchmarks and diagnostics.</p></div><SlidersHorizontal size={16} /></div>
                  <div className="form-grid">
                    <Field label="Context tokens"><input type="number" min={1024} max={1_000_000} step={1024} value={draft.server.contextTokens} onChange={(event) => update("server", { ...draft.server, contextTokens: Number(event.target.value) })} /></Field>
                    <Field label="Maximum output tokens"><input type="number" min={1} max={393_216} step={256} value={draft.server.maxOutputTokens} onChange={(event) => update("server", { ...draft.server, maxOutputTokens: Number(event.target.value) })} /></Field>
                    <Field label="CPU threads"><input type="number" min={1} max={256} value={draft.server.threads} onChange={(event) => update("server", { ...draft.server, threads: Number(event.target.value) })} /></Field>
                    <Field label="Prefill chunk" hint="Automatic"><input placeholder="Automatic" type="number" min={1} value={draft.server.prefillChunk ?? ""} onChange={(event) => update("server", { ...draft.server, prefillChunk: event.target.value ? Number(event.target.value) : null })} /></Field>
                  </div>
                  <Field label="Metal power" hint={`${draft.server.powerPercent}%`}><div className="range-field range-field--power"><input aria-label="Metal power percentage" type="range" min={1} max={100} value={draft.server.powerPercent} onChange={(event) => update("server", { ...draft.server, powerPercent: Number(event.target.value) })} /><span>{draft.server.powerPercent}%</span></div></Field>
                  <div className="inline-toggles"><div><span>Prepare model at startup</span><Toggle checked={draft.server.warmWeights} onChange={(warmWeights) => update("server", { ...draft.server, warmWeights })} label="Prepare model at startup" /></div><div><span>Cold start</span><Toggle checked={draft.streaming.coldStart} onChange={(coldStart) => update("streaming", { ...draft.streaming, coldStart })} label="Cold start" /></div></div>
                  {draft.repository.branch.includes("glm52") && <div className="branch-warning"><AlertTriangle size={15} /><p>For GLM 5.2, keep Metal power at 100% and prefill on automatic unless you are running a controlled experiment.</p></div>}
                </div>

                <div className="advanced-group">
                  <div className="advanced-group__head"><div><h3>Local API access</h3><p>Authentication for coding agents and apps on this Mac.</p></div><KeyRound size={16} /></div>
                  <div className="setting-row"><div><strong>Require an API key</strong><p>Apps must provide the token before using the model.</p></div><Toggle checked={draft.gateway.requireApiKey} onChange={(requireApiKey) => update("gateway", { ...draft.gateway, requireApiKey })} label="Require an API key" /></div>
                  <Field label="API key"><div className="secret-field"><input type={showKey ? "text" : "password"} value={draft.gateway.apiKey} onChange={(event) => update("gateway", { ...draft.gateway, apiKey: event.target.value })} /><button onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button><CopyButton value={draft.gateway.apiKey} label="Copy API key" /></div></Field>
                </div>

                <div className="advanced-group">
                  <div className="advanced-group__head"><div><h3>Diagnostics</h3><p>Disabled by default. Full traces may contain sensitive prompt data.</p></div><Eye size={16} /></div>
                  <div className="setting-row"><div><strong>Capture full diagnostics</strong><p>Saves requests, responses, and model decisions locally.</p></div><Toggle checked={draft.observability.traceEnabled} onChange={(traceEnabled) => update("observability", { ...draft.observability, traceEnabled })} label="Capture full diagnostics" /></div>
                  {draft.observability.traceEnabled && <Field label="Diagnostics file"><input value={draft.observability.tracePath} onChange={(event) => update("observability", { ...draft.observability, tracePath: event.target.value })} /></Field>}
                  <div className="setting-row"><div><strong>Model statistics</strong><p>Collects aggregate expert data for local optimization work.</p></div><Toggle checked={draft.observability.imatrixEnabled} onChange={(imatrixEnabled) => update("observability", { ...draft.observability, imatrixEnabled })} label="Model statistics" /></div>
                  {draft.observability.imatrixEnabled && <div className="form-grid"><Field label="Statistics file"><input value={draft.observability.imatrixPath} onChange={(event) => update("observability", { ...draft.observability, imatrixPath: event.target.value })} /></Field><Field label="Save every N requests"><input type="number" min={0} value={draft.observability.imatrixEvery} onChange={(event) => update("observability", { ...draft.observability, imatrixEvery: Number(event.target.value) })} /></Field></div>}
                  {draft.observability.traceEnabled && <div className="danger-note"><AlertTriangle size={15} /><p>Full diagnostics contain sensitive data in plain text. Review the file before sharing it.</p></div>}
                </div>

                <div className="advanced-group">
                  <div className="advanced-group__head"><div><h3>Additional DS4 flags</h3><p>Passed directly to the engine without invoking a shell.</p></div><Terminal size={16} /></div>
                  <Field label="Additional arguments" hint="e.g. --ssd-streaming-full-layers 0"><textarea rows={3} value={draft.advanced.extraArgs} onChange={(event) => update("advanced", { ...draft.advanced, extraArgs: event.target.value })} placeholder="--flag value" /></Field>
                  <Field label="Environment variables" hint="one KEY=value per line"><textarea rows={5} value={draft.advanced.environment} onChange={(event) => update("advanced", { ...draft.advanced, environment: event.target.value })} placeholder={"DS4_METAL_MEMORY_REPORT=1\n# other diagnostic variables"} /></Field>
                  <div className="labs-note"><AlertTriangle size={15} /><p>Experimental flags remain off unless you enable them explicitly.</p></div>
                </div>

                <div className="advanced-group command-preview-card">
                  <div className="advanced-group__head"><div><h3>Launch command</h3><p>The exact command DSBox will run.</p></div><CopyButton value={commandPreview} /></div>
                  <pre><code>{commandPreview}</code></pre>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        <p className="settings-default-note">Defaults are tuned for this Mac. If you never open Advanced, DSBox keeps the engine balanced automatically.</p>
      </div>

      <div className="settings-savebar">
        <div className="settings-savebar__inner">
          <div>{runtimeActive && dirty ? <><AlertTriangle size={15} /><span>Restart required to apply changes</span></> : saved ? <><Check size={15} /><span>Configuration saved</span></> : dirty ? <><span className="unsaved-dot" /><span>Unsaved changes</span></> : <><ShieldCheck size={15} /><span>Configuration in sync</span></>}</div>
          {dirty && <div><Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => setDraft(cloneConfig(snapshot.config))}>Reset</Button>{runtimeActive ? <Button variant="primary" icon={<Save size={15} />} loading={saving} onClick={() => { void save().then(() => controller.action("Restart runtime", "/api/runtime/restart")).catch(() => undefined); }}>Save and restart</Button> : <Button variant="primary" icon={<Save size={15} />} loading={saving} onClick={() => void save().catch(() => undefined)}>Save changes</Button>}</div>}
        </div>
      </div>
    </div>
  );
}
