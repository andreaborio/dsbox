import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Code2,
  Command,
  KeyRound,
  Link2,
  MessagesSquare,
  Network,
  Play,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  Unplug,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { Button, CopyButton, StatusPill } from "../components/ui";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

type AdapterId = "codex" | "claude" | "opencode" | "pi" | "generic";

const adapterMeta: Array<{ id: AdapterId; name: string; detail: string; icon: typeof Bot }> = [
  { id: "codex", name: "Codex CLI", detail: "Responses API", icon: Command },
  { id: "claude", name: "Claude Code", detail: "Anthropic Messages", icon: Bot },
  { id: "opencode", name: "OpenCode", detail: "Chat Completions", icon: TerminalSquare },
  { id: "pi", name: "Pi", detail: "Compatibile OpenAI", icon: Code2 },
  { id: "generic", name: "Generico", detail: "cURL / SDK", icon: Network }
];

export function AgentsView({ snapshot, onNavigate }: Props) {
  const [adapter, setAdapter] = useState<AdapterId>("codex");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "error" | null>(null);
  const testSequence = useRef(0);
  const { config, runtime, system } = snapshot;
  const base = system.openAiBaseUrl;
  const root = system.anthropicBaseUrl;
  const model = config.model.id;

  useEffect(() => {
    testSequence.current += 1;
    setTesting(false);
    setTestResult(null);
  }, [base, runtime.phase]);

  const snippets = useMemo<Record<AdapterId, { file: string; description: string; code: string; run?: string }>>(() => ({
    codex: {
      file: "~/.codex/config.toml",
      description: "Codex usa l'endpoint Responses nativo della fork, con streaming di testo e tool call.",
      code: `[model_providers.ds4]\nname = "DS4 local"\nbase_url = "${base}"\nwire_api = "responses"${config.gateway.requireApiKey ? '\nenv_key = "DSBOX_API_KEY"' : ""}\nstream_idle_timeout_ms = 1000000`,
      run: `${config.gateway.requireApiKey ? `DSBOX_API_KEY=${config.gateway.apiKey} ` : ""}codex --model ${model} -c model_provider=ds4`
    },
    claude: {
      file: "~/bin/claude-ds4",
      description: "Claude Code si collega alla route Anthropic /v1/messages. Il base URL non include /v1.",
      code: `#!/bin/sh\nunset ANTHROPIC_API_KEY\n\nexport ANTHROPIC_BASE_URL="${root}"\nexport ANTHROPIC_AUTH_TOKEN="${config.gateway.apiKey}"\nexport ANTHROPIC_MODEL="${model}"\nexport ANTHROPIC_DEFAULT_SONNET_MODEL="${model}"\nexport ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"\nexport ANTHROPIC_DEFAULT_OPUS_MODEL="${model}"\nexport CLAUDE_CODE_SUBAGENT_MODEL="${model}"\nexport CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\nexport CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1\nexport CLAUDE_STREAM_IDLE_TIMEOUT_MS=600000\n\nexec "$HOME/.local/bin/claude" "$@"`
    },
    opencode: {
      file: "~/.config/opencode/opencode.json",
      description: "Provider OpenAI-compatible con context allineato al profilo DSBox corrente.",
      code: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          ds4: {
            name: "DS4 local",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: base, apiKey: config.gateway.apiKey },
            models: {
              [model]: {
                name: `${model} · DSBox`,
                limit: { context: config.server.contextTokens, output: config.server.maxOutputTokens }
              }
            }
          }
        },
        agent: { ds4: { description: "Local model served by DSBox", model: `ds4/${model}` } }
      }, null, 2)
    },
    pi: {
      file: "~/.pi/agent/models.json",
      description: "Configurazione compatibile con il reasoning DeepSeek e usage nello stream SSE.",
      code: JSON.stringify({
        providers: {
          ds4: {
            name: "DS4 local",
            baseUrl: base,
            api: "openai-completions",
            apiKey: config.gateway.apiKey,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
              supportsUsageInStreaming: true,
              maxTokensField: "max_tokens",
              thinkingFormat: "deepseek"
            },
            models: [{
              id: model,
              name: `${model} · DSBox`,
              reasoning: true,
              contextWindow: config.server.contextTokens,
              maxTokens: config.server.maxOutputTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }]
          }
        }
      }, null, 2)
    },
    generic: {
      file: "Terminale",
      description: "Richiesta OpenAI Chat Completions minimale con streaming disabilitato per leggibilità.",
      code: `curl ${base}/chat/completions \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer ${config.gateway.apiKey}' \\\n  -d '${JSON.stringify({ model, messages: [{ role: "user", content: "Scrivi hello world in Rust." }], stream: false })}'`
    }
  }), [base, config.gateway.apiKey, config.server.contextTokens, config.server.maxOutputTokens, model, root]);

  const current = snippets[adapter];

  const testConnection = async () => {
    const sequence = ++testSequence.current;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(`${base}/models`, {
        headers: config.gateway.requireApiKey ? { Authorization: `Bearer ${config.gateway.apiKey}` } : undefined
      });
      if (!response.ok) throw new Error();
      if (testSequence.current !== sequence) return;
      setTestResult("ok");
    } catch {
      if (testSequence.current !== sequence) return;
      setTestResult("error");
    } finally {
      if (testSequence.current === sequence) setTesting(false);
    }
  };

  const endpoints = [
    { label: "OpenAI", protocol: "Codex e app compatibili", url: base, icon: MessagesSquare },
    { label: "Anthropic", protocol: "Claude Code", url: root, icon: Bot },
    { label: "Stato", protocol: "Controllo disponibilità", url: `${base}/models`, icon: Zap }
  ];

  return (
    <div className="agents-page page-scroll">
      <section className="agents-intro">
        <div>
          <span className="eyebrow"><Link2 size={13} /> Connessione locale</span>
          <h2>Collega il coding agent che preferisci.</h2>
          <p>Scegli il tuo strumento e copia la configurazione pronta. DSBox gestisce indirizzo, modello e sicurezza.</p>
        </div>
        <div className="agents-intro__status panel">
          <StatusPill phase={runtime.phase} />
          <div><span>Indirizzo</span><strong>{system.gatewayBaseUrl.replace("http://", "")}</strong></div>
          <button className={testResult === "error" ? "connection-test--error" : ""} onClick={() => void testConnection()} disabled={testing} aria-live="polite">
            {testing ? <RefreshCw size={14} className="spin" /> : testResult === "ok" ? <CircleCheck size={14} /> : testResult === "error" ? <Unplug size={14} /> : <Play size={14} />}
            {testing ? "Verifico…" : testResult === "ok" ? "Pronto" : testResult === "error" ? "Non raggiungibile" : "Verifica connessione"}
          </button>
        </div>
      </section>

      {testResult === "error" && (
        <div className="connection-error" role="alert">
          <Unplug size={17} />
          <div>
            <strong>{runtime.phase === "running" ? "Gateway non raggiungibile" : "DSBox è spento"}</strong>
            <p>{runtime.phase === "running" ? "Controlla lo stato del server e riprova." : "Accendi il server e riprova la verifica."}</p>
          </div>
          <Button variant="secondary" onClick={() => onNavigate("runtime")}>Vai al server</Button>
        </div>
      )}

      <section className="endpoint-grid">
        {endpoints.map((endpoint) => {
          const Icon = endpoint.icon;
          return (
            <article className="endpoint-card panel" key={endpoint.label}>
              <span className="endpoint-card__icon"><Icon size={17} /></span>
              <div><strong>{endpoint.label}</strong><small>{endpoint.protocol}</small><code>{endpoint.url}</code></div>
              <CopyButton value={endpoint.url} label={`Copia URL ${endpoint.label}`} />
            </article>
          );
        })}
      </section>

      <section className="connector-workbench panel">
        <aside className="connector-list">
          <div className="connector-list__heading">Scegli l'agente</div>
          {adapterMeta.map((item) => {
            const Icon = item.icon;
            return (
              <button className={adapter === item.id ? "active" : ""} onClick={() => setAdapter(item.id)} key={item.id} aria-label={item.name} aria-pressed={adapter === item.id} title={item.name}>
                <span><Icon size={17} /></span>
                <div><strong>{item.name}</strong><small>{item.detail}</small></div>
                <ChevronRight size={14} />
              </button>
            );
          })}
          <div className="connector-list__note"><ShieldCheck size={15} /><p>Il server interno non viene mai esposto sulla rete.</p></div>
        </aside>

        <div className="connector-detail">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={adapter} initial={{ opacity: 0, x: 5 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -5 }} transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}>
              <div className="connector-detail__head">
                <div>
                  <span className="connector-file">{current.file}</span>
                  <h3>{adapterMeta.find((item) => item.id === adapter)?.name}</h3>
                  <p>{current.description}</p>
                </div>
                <CopyButton value={current.code} label="Copia configurazione" />
              </div>
              <div className="code-window">
                <div className="code-window__bar"><i /><i /><i /><span>{current.file}</span></div>
                <pre><code>{current.code}</code></pre>
              </div>
              {current.run && (
                <div className="run-command"><TerminalSquare size={15} /><code>{current.run}</code><CopyButton value={current.run} label="Copia comando" /></div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      <section className="agent-notes">
        <article className="panel">
          <span><KeyRound size={17} /></span>
          <div><strong>Autenticazione locale</strong><p>{config.gateway.requireApiKey ? "Il gateway richiede il token mostrato nelle configurazioni." : "La chiave è un placeholder perché il gateway è limitato a 127.0.0.1."}</p></div>
        </article>
        <article className="panel">
          <span><ShieldCheck size={17} /></span>
          <div><strong>Avvii più rapidi</strong><p>DSBox può riusare il contesto già elaborato senza ricominciare ogni volta da zero.</p></div>
        </article>
        <article className="panel">
          <span><Network size={17} /></span>
          <div><strong>Richieste ordinate</strong><p>Quando arrivano più richieste insieme, DSBox le gestisce in sequenza per restare stabile.</p></div>
        </article>
      </section>

      <div className="compatibility-note"><CircleAlert size={14} /><p>Le configurazioni usano automaticamente il modello selezionato in DSBox.</p></div>
    </div>
  );
}
