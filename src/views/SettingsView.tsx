import {
  AlertTriangle,
  Box,
  Check,
  Code2,
  Cpu,
  Database,
  Eye,
  EyeOff,
  FolderGit2,
  HardDrive,
  KeyRound,
  MemoryStick,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppSnapshot, CatalogModel, CatalogResponse, DsboxConfig, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { Button, CopyButton, Field, Modal, Select, Toggle } from "../components/ui";
import { formatBytes, formatModelName } from "../lib/format";
import { apiRequest } from "../lib/api";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

type SettingsTab = "runtime" | "performance" | "storage" | "advanced";

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Server }> = [
  { id: "runtime", label: "Server e modello", icon: Server },
  { id: "performance", label: "Prestazioni", icon: Zap },
  { id: "storage", label: "Dati e privacy", icon: HardDrive },
  { id: "advanced", label: "Avanzate", icon: Code2 }
];

const conversationPresets = [
  { value: 32_768, label: "Standard" },
  { value: 65_536, label: "Lunga" },
  { value: 100_000, label: "Molto lunga" }
] as const;

const responsePresets = [
  { value: 8_192, label: "Standard" },
  { value: 16_384, label: "Lunga" },
  { value: 32_768, label: "Molto lunga" }
] as const;

function cloneConfig(config: DsboxConfig): DsboxConfig {
  return structuredClone(config);
}

export function SettingsView({ snapshot, controller }: Props) {
  const [tab, setTab] = useState<SettingsTab>("runtime");
  const [draft, setDraft] = useState(() => cloneConfig(snapshot.config));
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showCustomModel, setShowCustomModel] = useState(false);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [selectedCatalogModel, setSelectedCatalogModel] = useState<CatalogModel | null>(null);

  useEffect(() => {
    setDraft(cloneConfig(snapshot.config));
  }, [snapshot.config]);

  useEffect(() => {
    void apiRequest<CatalogResponse>("/api/models/catalog").then(setCatalog).catch(() => undefined);
  }, []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(snapshot.config), [draft, snapshot.config]);
  const runtimeActive = ["running", "starting"].includes(snapshot.runtime.phase);
  const recommendedModel = catalog?.models.find((model) => model.recommended && (!model.runtimeBranch || model.runtimeBranch === draft.repository.branch)) ?? null;
  const otherCatalogModels = catalog?.models.filter((model) => model.repository !== recommendedModel?.repository) ?? [];
  const automaticModelName = recommendedModel?.label ?? "DeepSeek V4 Flash";
  const automaticModelId = recommendedModel?.modelId ?? "deepseek-v4-flash";
  const automaticModelPath = `${draft.repository.directory}/ds4flash.gguf`;
  const recommendedRepositoryName = recommendedModel?.repository.split("/").at(-1);
  const automaticSelected = recommendedModel
    ? draft.model.id === automaticModelId && Boolean(recommendedRepositoryName && draft.model.path.includes(`/models/${recommendedRepositoryName}/`))
    : draft.model.id === automaticModelId && draft.model.path === automaticModelPath;

  const update = <K extends keyof DsboxConfig>(section: K, value: DsboxConfig[K]) => {
    setDraft((current) => ({ ...current, [section]: value }));
    setSaved(false);
  };

  const save = async () => {
    await controller.saveConfig(draft);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const useAutomaticModel = () => {
    const balancedForUnifiedMemory = snapshot.system.totalMemoryBytes <= 72 * 1024 ** 3;
    update("model", { id: automaticModelId, path: automaticModelPath });
    if (!recommendedModel) {
      update("repository", { ...draft.repository, branch: "main" });
    }
    update("streaming", {
      ...draft.streaming,
      enabled: true,
      cacheMode: balancedForUnifiedMemory ? "manual" : "auto",
      cacheSizeGb: 32
    });
    setShowCustomModel(false);
  };

  const downloadCatalogModel = async () => {
    if (!selectedCatalogModel) return;
    const selected = selectedCatalogModel;
    setSelectedCatalogModel(null);
    await controller.action("Download modello", "/api/models/download", { repository: selected.repository });
  };

  const commandPreview = useMemo(() => {
    const parts = [
      `${draft.repository.directory}/ds4-server`,
      "--chdir", draft.repository.directory,
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
    <div className="settings-page">
      <aside className="settings-nav">
        <div className="settings-nav__intro"><span className="eyebrow">Modello attivo</span><strong>{formatModelName(draft.model.id)}</strong><p>DSBox applica automaticamente le impostazioni consigliate.</p></div>
        {tabs.map((item) => {
          const Icon = item.icon;
          return <button className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} key={item.id} aria-label={item.label} aria-pressed={tab === item.id} title={item.label}><Icon size={16} /><span>{item.label}</span></button>;
        })}
        <div className="settings-nav__system">
          <span><Cpu size={14} /> {snapshot.system.cpuModel.replace(/Apple\s*/i, "")}</span>
          <span><MemoryStick size={14} /> {formatBytes(snapshot.system.totalMemoryBytes, 0)}</span>
          <span><ShieldCheck size={14} /> Solo sul tuo Mac</span>
        </div>
      </aside>

      <div className="settings-content page-scroll">
        {tab === "runtime" && (
          <section className="settings-section">
            <div className="settings-section__heading"><span className="section-icon"><Box size={19} /></span><div><h2>Server e modello</h2><p>Scegli il modello. DSBox gestisce automaticamente il motore locale e la memoria.</p></div></div>

            <div className={`settings-card model-choice-card panel ${automaticSelected ? "model-choice-card--selected" : ""}`}>
              <div className="model-choice-card__head">
                <span className="model-choice-card__icon"><Sparkles size={20} /></span>
                <div>
                  <span className="model-choice-card__label">Scelta automatica</span>
                  <h3>{automaticModelName}</h3>
                  <p>{recommendedModel?.description ?? "Il profilo predefinito per usare il modello con Metal e streaming da SSD, senza configurazione manuale."}</p>
                </div>
                <span className="dsbox-recommended"><Check size={12} /> Consigliato da DSBox</span>
              </div>
              <div className="model-choice-card__facts">
                <div><span>Ottimizzazione</span><strong>Metal + SSD streaming</strong></div>
                <div><span>Memoria</span><strong>Gestita automaticamente</strong></div>
                <div><span>Fonte</span><strong>{recommendedModel ? "Hugging Face · andreaborio" : "Profilo DSBox"}</strong></div>
              </div>
              <div className="model-choice-card__actions">
                <span className={snapshot.runtime.modelPresent && draft.model.id === automaticModelId ? "verified-chip" : "pending-chip"}>
                  {snapshot.runtime.modelPresent && draft.model.id === automaticModelId ? <Check size={12} /> : <HardDrive size={12} />}
                  {snapshot.runtime.modelPresent && draft.model.id === automaticModelId ? "Pronto sul Mac" : "Si prepara alla prima accensione"}
                </span>
                {recommendedModel && (!automaticSelected || !snapshot.runtime.modelPresent) ? (
                  <Button variant="primary" disabled={!recommendedModel.installable} onClick={() => setSelectedCatalogModel(recommendedModel)}>Scarica e usa</Button>
                ) : !automaticSelected ? (
                  <Button variant="secondary" onClick={useAutomaticModel}>Usa scelta automatica</Button>
                ) : <span className="model-selected-label"><Check size={13} /> Selezionato</span>}
              </div>
            </div>

            {otherCatalogModels.length > 0 && (
              <div className="settings-card panel catalog-models-card">
                <div className="settings-card__head"><div><h3>Altri modelli</h3><p>Versioni pubblicate nel catalogo DSBox. Le versioni sperimentali non vengono mai scelte automaticamente.</p></div><Box size={17} /></div>
                <div className="catalog-model-list">
                  {otherCatalogModels.map((model) => {
                    const branchCompatible = !model.runtimeBranch || model.runtimeBranch === draft.repository.branch;
                    return (
                      <article key={model.repository}>
                        <div><strong>{model.label}</strong><p>{model.description}</p><small>Hugging Face · andreaborio{model.totalBytes ? ` · ${formatBytes(model.totalBytes, 0)}` : ""}</small></div>
                        <div>
                          {model.experimental && <span className="experimental-chip">Sperimentale</span>}
                          {model.installable && branchCompatible
                            ? <Button variant="secondary" onClick={() => setSelectedCatalogModel(model)}>Dettagli</Button>
                            : <span className="catalog-unavailable">{model.unavailableReason ?? `Richiede il canale ${model.runtimeBranch}`}</span>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="settings-card panel custom-model-card">
              <button className="custom-model-toggle" onClick={() => setShowCustomModel((value) => !value)} aria-expanded={showCustomModel}>
                <span><HardDrive size={17} /><span><strong>Usa un modello dal Mac</strong><small>Per chi ha già un file GGUF compatibile.</small></span></span>
                <span>{showCustomModel ? "Nascondi" : "Configura"}</span>
              </button>
              {showCustomModel && (
                <div className="form-grid custom-model-fields">
                  <Field label="Nome del modello"><input value={draft.model.id} onChange={(event) => update("model", { ...draft.model, id: event.target.value })} /></Field>
                  <Field label="Motore"><div className="locked-field"><Cpu size={15} /> Metal <ShieldCheck size={13} /></div></Field>
                  <Field label="Percorso del file GGUF" className="form-grid--full"><input value={draft.model.path} onChange={(event) => update("model", { ...draft.model, path: event.target.value })} /></Field>
                  <div className="privacy-note form-grid--full"><ShieldCheck size={16} /><p>Il file resta nella posizione scelta e non viene caricato online.</p></div>
                </div>
              )}
            </div>
          </section>
        )}

        {tab === "performance" && (
          <section className="settings-section">
            <div className="settings-section__heading"><span className="section-icon"><Zap size={19} /></span><div><h2>Prestazioni</h2><p>Le impostazioni consigliate sono già selezionate. Qui puoi adattare memoria e qualità.</p></div></div>
            <div className="settings-card panel">
              <div className="setting-row setting-row--hero">
                <span className="setting-row__icon"><HardDrive size={18} /></span>
                <div><strong>Streaming ottimizzato da SSD</strong><p>Mantiene in memoria le parti più utili del modello e carica il resto quando serve.</p></div>
                <Toggle checked={draft.streaming.enabled} onChange={(enabled) => update("streaming", { ...draft.streaming, enabled })} label="Streaming ottimizzato da SSD" />
              </div>
              {draft.streaming.enabled && (
                <div className="nested-settings">
                  <div className="segmented-control"><button className={draft.streaming.cacheMode === "manual" ? "active" : ""} aria-pressed={draft.streaming.cacheMode === "manual"} onClick={() => update("streaming", { ...draft.streaming, cacheMode: "manual" })}>Bilanciata</button><button className={draft.streaming.cacheMode === "auto" ? "active" : ""} aria-pressed={draft.streaming.cacheMode === "auto"} onClick={() => update("streaming", { ...draft.streaming, cacheMode: "auto" })}>Adattiva</button></div>
                  {draft.streaming.cacheMode === "manual" && <Field label="Memoria riservata al modello" hint={`${draft.streaming.cacheSizeGb} GB`}><div className="range-field"><input aria-label="Memoria riservata al modello, cursore" type="range" min={8} max={128} step={4} value={draft.streaming.cacheSizeGb} onChange={(event) => update("streaming", { ...draft.streaming, cacheSizeGb: Number(event.target.value) })} /><input aria-label="Memoria riservata al modello in GB" type="number" min={1} max={1024} value={draft.streaming.cacheSizeGb} onChange={(event) => update("streaming", { ...draft.streaming, cacheSizeGb: Number(event.target.value) })} /><span>GB</span></div></Field>}
                </div>
              )}
            </div>

            <div className="settings-card panel">
              <div className="settings-card__head"><div><h3>Conversazione e qualità</h3><p>Più contesto e risposte lunghe richiedono più memoria.</p></div><SlidersHorizontal size={17} /></div>
              <div className="form-grid">
                <Field label="Memoria della conversazione"><Select value={draft.server.contextTokens} onChange={(event) => update("server", { ...draft.server, contextTokens: Number(event.target.value) })}>{!conversationPresets.some((preset) => preset.value === draft.server.contextTokens) && <option value={draft.server.contextTokens}>Personalizzata</option>}{conversationPresets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</Select></Field>
                <Field label="Lunghezza delle risposte"><Select value={draft.server.maxOutputTokens} onChange={(event) => update("server", { ...draft.server, maxOutputTokens: Number(event.target.value) })}>{!responsePresets.some((preset) => preset.value === draft.server.maxOutputTokens) && <option value={draft.server.maxOutputTokens}>Personalizzata</option>}{responsePresets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</Select></Field>
              </div>
              <div className="setting-row"><div><strong>Massima qualità</strong><p>Privilegia la precisione quando una risposta può richiedere un po' più di tempo.</p></div><Toggle checked={draft.server.quality} onChange={(quality) => update("server", { ...draft.server, quality })} label="Massima qualità" /></div>
            </div>
          </section>
        )}

        {tab === "storage" && (
          <section className="settings-section">
            <div className="settings-section__heading"><span className="section-icon"><HardDrive size={19} /></span><div><h2>Dati e privacy</h2><p>Scegli cosa conservare sul Mac per rendere più rapidi gli utilizzi successivi.</p></div></div>
            <div className="settings-card panel">
              <div className="setting-row setting-row--hero"><span className="setting-row__icon"><Database size={18} /></span><div><strong>Riusa il contesto</strong><p>Conserva sul Mac parte delle conversazioni lunghe per velocizzare coding agent e richieste ripetute.</p></div><Toggle checked={draft.kvCache.enabled} onChange={(enabled) => update("kvCache", { ...draft.kvCache, enabled })} label="Riusa il contesto" /></div>
              {draft.kvCache.enabled && <div className="nested-settings form-grid"><Field label="Cartella del contesto" className="form-grid--full"><input value={draft.kvCache.directory} onChange={(event) => update("kvCache", { ...draft.kvCache, directory: event.target.value })} /></Field><Field label="Spazio massimo in MB"><input type="number" min={1} value={draft.kvCache.spaceMb} onChange={(event) => update("kvCache", { ...draft.kvCache, spaceMb: Number(event.target.value) })} /></Field><Field label="Lunghezza minima"><input type="number" min={0} value={draft.kvCache.minTokens} onChange={(event) => update("kvCache", { ...draft.kvCache, minTokens: Number(event.target.value) })} /></Field><Field label="Intervallo di salvataggio" className="form-grid--full"><input type="number" min={0} value={draft.kvCache.continuedIntervalTokens} onChange={(event) => update("kvCache", { ...draft.kvCache, continuedIntervalTokens: Number(event.target.value) })} /></Field></div>}
              <div className="privacy-note"><ShieldCheck size={16} /><p>Il contesto può contenere parti dei prompt. Resta nella tua cartella utente e non viene caricato online.</p></div>
            </div>

            <div className="settings-card panel">
              <div className="settings-card__head"><div><h3>Diagnostica</h3><p>Queste opzioni servono solo per analizzare problemi e prestazioni.</p></div><Eye size={17} /></div>
              <div className="setting-row"><div><strong>Registra diagnostica completa</strong><p>Salva richieste, risposte e decisioni interne del modello.</p></div><Toggle checked={draft.observability.traceEnabled} onChange={(traceEnabled) => update("observability", { ...draft.observability, traceEnabled })} label="Registra diagnostica completa" /></div>
              {draft.observability.traceEnabled && <Field label="File di diagnostica"><input value={draft.observability.tracePath} onChange={(event) => update("observability", { ...draft.observability, tracePath: event.target.value })} /></Field>}
              <div className="setting-row"><div><strong>Statistiche del modello</strong><p>Raccoglie dati aggregati sugli expert per ottimizzazioni future.</p></div><Toggle checked={draft.observability.imatrixEnabled} onChange={(imatrixEnabled) => update("observability", { ...draft.observability, imatrixEnabled })} label="Statistiche del modello" /></div>
              {draft.observability.imatrixEnabled && <div className="form-grid"><Field label="File statistiche"><input value={draft.observability.imatrixPath} onChange={(event) => update("observability", { ...draft.observability, imatrixPath: event.target.value })} /></Field><Field label="Salva ogni N richieste"><input type="number" min={0} value={draft.observability.imatrixEvery} onChange={(event) => update("observability", { ...draft.observability, imatrixEvery: Number(event.target.value) })} /></Field></div>}
              {draft.observability.traceEnabled && <div className="danger-note"><AlertTriangle size={16} /><p>La diagnostica completa contiene testo sensibile in chiaro. Non condividerla senza revisione.</p></div>}
            </div>
          </section>
        )}

        {tab === "advanced" && (
          <section className="settings-section">
            <div className="settings-section__heading"><span className="section-icon"><Code2 size={19} /></span><div><h2>Avanzate</h2><p>Configurazione tecnica del motore. I valori non supportati vengono rifiutati prima dell'avvio.</p></div></div>

            <div className="settings-card panel">
              <div className="settings-card__head"><div><h3>Motore DS4</h3><p>DSBox usa la fork <code>andreaborio/ds4</code> e conserva eventuali modifiche locali durante gli aggiornamenti.</p></div><FolderGit2 size={17} /></div>
              <div className="form-grid">
                <Field label="Repository" hint="Solo HTTPS" className="form-grid--full"><input value={draft.repository.url} onChange={(event) => update("repository", { ...draft.repository, url: event.target.value })} /></Field>
                <Field label="Canale del motore"><Select value={draft.repository.branch} onChange={(event) => {
                  const branch = event.target.value;
                  update("repository", { ...draft.repository, branch });
                  update("model", { ...draft.model, id: branch.includes("glm52") ? "glm-5.2" : "deepseek-v4-flash" });
                }}><option value="main">DeepSeek · stabile</option><option value="codex/glm52-upstream-clean-bench">GLM 5.2 · sperimentale</option></Select></Field>
                <Field label="Porta privata"><input type="number" min={1024} max={65535} value={draft.server.internalPort} onChange={(event) => update("server", { ...draft.server, internalPort: Number(event.target.value) })} /></Field>
                <Field label="Cartella del motore" className="form-grid--full"><input value={draft.repository.directory} onChange={(event) => update("repository", { ...draft.repository, directory: event.target.value })} /></Field>
              </div>
              <div className="privacy-note"><ShieldCheck size={16} /><p>Il server e le API restano disponibili solo su questo Mac.</p></div>
            </div>

            <div className="settings-card panel">
              <div className="settings-card__head"><div><h3>Parametri del motore</h3><p>Questi controlli servono per benchmark e diagnosi. Il profilo DSBox è il punto di partenza consigliato.</p></div><SlidersHorizontal size={17} /></div>
              <div className="form-grid">
                <Field label="Context token"><input type="number" min={1024} max={1_000_000} step={1024} value={draft.server.contextTokens} onChange={(event) => update("server", { ...draft.server, contextTokens: Number(event.target.value) })} /></Field>
                <Field label="Token massimi output"><input type="number" min={1} max={393_216} step={256} value={draft.server.maxOutputTokens} onChange={(event) => update("server", { ...draft.server, maxOutputTokens: Number(event.target.value) })} /></Field>
                <Field label="Thread CPU"><input type="number" min={1} max={256} value={draft.server.threads} onChange={(event) => update("server", { ...draft.server, threads: Number(event.target.value) })} /></Field>
                <Field label="Blocco di prefill" hint="Automatico"><input placeholder="Automatico" type="number" min={1} value={draft.server.prefillChunk ?? ""} onChange={(event) => update("server", { ...draft.server, prefillChunk: event.target.value ? Number(event.target.value) : null })} /></Field>
              </div>
              <Field label="Potenza Metal" hint={`${draft.server.powerPercent}%`}><div className="range-field range-field--power"><input aria-label="Potenza Metal in percentuale" type="range" min={1} max={100} value={draft.server.powerPercent} onChange={(event) => update("server", { ...draft.server, powerPercent: Number(event.target.value) })} /><span>{draft.server.powerPercent}%</span></div></Field>
              <div className="setting-row"><div><strong>Prepara il modello all'avvio</strong><p>Riduce la latenza della prima richiesta caricando in anticipo i pesi più utili.</p></div><Toggle checked={draft.server.warmWeights} onChange={(warmWeights) => update("server", { ...draft.server, warmWeights })} label="Prepara il modello all'avvio" /></div>
              <div className="setting-row"><div><strong>Avvio senza preparazione</strong><p>Disattiva l'ottimizzazione iniziale per confronti tecnici a freddo.</p></div><Toggle checked={draft.streaming.coldStart} onChange={(coldStart) => update("streaming", { ...draft.streaming, coldStart })} label="Avvio senza preparazione" /></div>
              {draft.repository.branch.includes("glm52") && <div className="branch-warning"><AlertTriangle size={15} /><p>Per GLM 5.2 DSBox mantiene la potenza al 100% e il prefill automatico, salvo esperimenti espliciti.</p></div>}
            </div>

            <div className="settings-card panel">
              <div className="settings-card__head"><div><h3>Accesso API locale</h3><p>Protegge gli URL usati da coding agent e applicazioni sul Mac.</p></div><KeyRound size={17} /></div>
              <div className="setting-row"><div><strong>Richiedi una chiave API</strong><p>Le applicazioni devono presentare il token prima di usare il modello.</p></div><Toggle checked={draft.gateway.requireApiKey} onChange={(requireApiKey) => update("gateway", { ...draft.gateway, requireApiKey })} label="Richiedi una chiave API" /></div>
              <Field label="Chiave API"><div className="secret-field"><input type={showKey ? "text" : "password"} value={draft.gateway.apiKey} onChange={(event) => update("gateway", { ...draft.gateway, apiKey: event.target.value })} /><button onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "Nascondi chiave" : "Mostra chiave"}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button><CopyButton value={draft.gateway.apiKey} label="Copia chiave API" /></div></Field>
            </div>

            <div className="settings-card panel">
              <div className="settings-card__head"><div><h3>Flag DS4 aggiuntivi</h3><p>Vengono passati direttamente al motore, senza usare una shell.</p></div><Terminal size={17} /></div>
              <Field label="Argomenti aggiuntivi" hint="es. --ssd-streaming-full-layers 0"><textarea rows={4} value={draft.advanced.extraArgs} onChange={(event) => update("advanced", { ...draft.advanced, extraArgs: event.target.value })} placeholder="--flag value" /></Field>
              <Field label="Variabili d'ambiente" hint="una KEY=value per riga"><textarea rows={7} value={draft.advanced.environment} onChange={(event) => update("advanced", { ...draft.advanced, environment: event.target.value })} placeholder={"DS4_METAL_MEMORY_REPORT=1\n# altre variabili diagnostiche"} /></Field>
              <div className="labs-note"><AlertTriangle size={16} /><p>Router-ahead, readahead, virtual resident e MTP restano esperimenti. DSBox non li attiva automaticamente perché i benchmark della fork non mostrano un vantaggio stabile.</p></div>
            </div>

            <div className="settings-card panel command-preview-card">
              <div className="settings-card__head"><div><h3>Comando di avvio</h3><p>Anteprima tecnica del comando che DSBox eseguirà.</p></div><CopyButton value={commandPreview} /></div>
              <pre><code>{commandPreview}</code></pre>
            </div>
          </section>
        )}

        <div className="settings-savebar">
          <div className="settings-savebar__inner">
            <div>
              {runtimeActive && dirty ? <><AlertTriangle size={15} /><span>Riavvio necessario per applicare</span></> : saved ? <><Check size={15} /><span>Configurazione salvata</span></> : dirty ? <><span className="unsaved-dot" /><span>Modifiche non salvate</span></> : <><ShieldCheck size={15} /><span>Configurazione sincronizzata</span></>}
            </div>
            {dirty && (
              <div>
                <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => setDraft(cloneConfig(snapshot.config))}>Ripristina</Button>
                {runtimeActive
                  ? <Button variant="primary" icon={<Save size={15} />} loading={controller.busyAction === "Salvataggio configurazione"} onClick={() => { void save().then(() => controller.action("Riavvio runtime", "/api/runtime/restart")).catch(() => undefined); }}>Salva e riavvia</Button>
                  : <Button variant="primary" icon={<Save size={15} />} loading={controller.busyAction === "Salvataggio configurazione"} onClick={() => void save().catch(() => undefined)}>Salva modifiche</Button>}
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={Boolean(selectedCatalogModel)}
        onClose={() => setSelectedCatalogModel(null)}
        title="Usa questo modello"
        footer={<><Button variant="ghost" onClick={() => setSelectedCatalogModel(null)}>Annulla</Button><Button variant="primary" disabled={!selectedCatalogModel?.installable} loading={controller.busyAction === "Download modello"} onClick={() => void downloadCatalogModel().catch(() => undefined)}>Scarica sul Mac</Button></>}
      >
        {selectedCatalogModel && (
          <div className="catalog-confirm">
            <span className="catalog-confirm__icon"><Box size={22} /></span>
            <div><strong>{selectedCatalogModel.label}</strong><p>{selectedCatalogModel.description}</p></div>
            <dl>
              <div><dt>Fonte</dt><dd>Hugging Face · andreaborio</dd></div>
              <div><dt>Dimensione</dt><dd>{selectedCatalogModel.totalBytes ? formatBytes(selectedCatalogModel.totalBytes, 0) : "Non disponibile"}</dd></div>
              <div><dt>Stato</dt><dd>{selectedCatalogModel.experimental ? "Sperimentale" : selectedCatalogModel.recommended ? "Consigliato da DSBox" : "Disponibile nel catalogo"}</dd></div>
            </dl>
            {selectedCatalogModel.unavailableReason && <div className="branch-warning"><AlertTriangle size={15} /><p>{selectedCatalogModel.unavailableReason}</p></div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
