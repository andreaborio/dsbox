import {
  Bot,
  CircleAlert,
  CircleCheck,
  Code2,
  Command,
  KeyRound,
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
import type { AppSnapshot, RuntimeState, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { Button, CopyButton, StatusPill } from "../components/ui";
import { getQwenAdapterCompatibility, type AgentAdapterId } from "../lib/agent-adapters";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

const adapterMeta: Array<{ id: AgentAdapterId; name: string; detail: string; icon: typeof Bot }> = [
  { id: "codex", name: "Codex CLI", detail: "Responses API", icon: Command },
  { id: "claude", name: "Claude Code", detail: "Anthropic Messages", icon: Bot },
  { id: "opencode", name: "OpenCode", detail: "Chat Completions", icon: TerminalSquare },
  { id: "pi", name: "Pi", detail: "OpenAI-compatible", icon: Code2 },
  { id: "generic", name: "Generic", detail: "cURL / SDK", icon: Network }
];

export type AgentConnectionState = "offline" | "loading" | "ready";

export interface AgentConnectionPresentation {
  state: AgentConnectionState;
  capabilityTitle: string;
  capabilityBadge: string;
  capabilityDescription: string;
  actionLabel: string;
}

export function resolveAgentConnectionPresentation(
  runtime: Pick<RuntimeState, "phase" | "readiness">,
  isQwen: boolean
): AgentConnectionPresentation {
  const state: AgentConnectionState = runtime.phase === "running" && runtime.readiness === "ready"
    ? "ready"
    : runtime.readiness === "loading" || ["preparing", "installing", "updating", "building", "downloading", "starting", "stopping"].includes(runtime.phase)
      ? "loading"
      : "offline";
  const runtimeName = isQwen ? "Qwen3.6" : "Agent gateway";

  if (state === "ready") {
    return {
      state,
      capabilityTitle: `${runtimeName} · Agent ready`,
      capabilityBadge: "Tools",
      capabilityDescription: isQwen
        ? "The active runtime supports OpenAI-compatible /v1/chat/completions with streaming, tools, tool_choice, and multiple tool calls. Responses API and Anthropic Messages are not exposed."
        : "The local gateway is ready for compatible coding agents.",
      actionLabel: isQwen ? "Check gateway" : "Test connection"
    };
  }

  if (state === "loading") {
    return {
      state,
      capabilityTitle: `${runtimeName} · Starting`,
      capabilityBadge: "Loading",
      capabilityDescription: "Hebrus Server is preparing the selected model. Agent connections become available when startup completes.",
      actionLabel: "Starting…"
    };
  }

  return {
    state,
    capabilityTitle: `${runtimeName} · Configured`,
    capabilityBadge: "Offline",
    capabilityDescription: "The connection details are ready. Turn on Hebrus Server before an agent can use the local model.",
    actionLabel: "Open server"
  };
}

export function AgentsView({ snapshot, onNavigate }: Props) {
  const { config, runtime, system } = snapshot;
  const isQwen = config.model.id === "qwen3.6-35b-a3b";
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "error" | null>(null);
  const testSequence = useRef(0);
  const base = system.openAiBaseUrl;
  const root = system.anthropicBaseUrl;
  const model = config.model.id;
  const connection = resolveAgentConnectionPresentation(runtime, isQwen);

  useEffect(() => {
    testSequence.current += 1;
    setTesting(false);
    setTestResult(null);
  }, [base, model, runtime.phase, runtime.readiness]);

  const snippets = useMemo<Record<AgentAdapterId, { file: string; description: string; code: string; run?: string }>>(() => ({
    codex: {
      file: "~/.codex/config.toml",
      description: "Codex uses the fork's native Responses endpoint, with streamed text and tool calls.",
      code: `[model_providers.ds4]\nname = "Hebrus local"\nbase_url = "${base}"\nwire_api = "responses"${config.gateway.requireApiKey ? '\nenv_key = "DSBOX_API_KEY"' : ""}\nstream_idle_timeout_ms = 1000000`,
      run: `${config.gateway.requireApiKey ? `DSBOX_API_KEY=${config.gateway.apiKey} ` : ""}codex --model ${model} -c model_provider=ds4`
    },
    claude: {
      file: "~/bin/claude-ds4",
      description: "Claude Code connects to the Anthropic /v1/messages route. The base URL does not include /v1.",
      code: `#!/bin/sh\nunset ANTHROPIC_API_KEY\n\nexport ANTHROPIC_BASE_URL="${root}"\nexport ANTHROPIC_AUTH_TOKEN="${config.gateway.apiKey}"\nexport ANTHROPIC_MODEL="${model}"\nexport ANTHROPIC_DEFAULT_SONNET_MODEL="${model}"\nexport ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"\nexport ANTHROPIC_DEFAULT_OPUS_MODEL="${model}"\nexport CLAUDE_CODE_SUBAGENT_MODEL="${model}"\nexport CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\nexport CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1\nexport CLAUDE_STREAM_IDLE_TIMEOUT_MS=600000\n\nexec "$HOME/.local/bin/claude" "$@"`
    },
    opencode: {
      file: "~/.config/opencode/opencode.json",
      description: "An OpenAI-compatible provider with a context window matched to the current Hebrus Studio profile.",
      code: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          ds4: {
            name: "Hebrus local",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: base, apiKey: config.gateway.apiKey },
            models: {
              [model]: {
                name: `${model} · Hebrus Studio`,
                limit: { context: config.server.contextTokens, output: config.server.maxOutputTokens }
              }
            }
          }
        },
        agent: { ds4: { description: "Local model served by Hebrus Studio", model: `ds4/${model}` } }
      }, null, 2)
    },
    pi: {
      file: "~/.pi/agent/models.json",
      description: "A configuration with streamed reasoning and usage data.",
      code: JSON.stringify({
        providers: {
          ds4: {
            name: "Hebrus local",
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
              name: `${model} · Hebrus Studio`,
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
      file: "Terminal",
      description: isQwen
        ? "This example is text-only with streaming disabled for readability. The Qwen endpoint also supports streaming, tools, tool_choice, and multiple tool calls."
        : "A minimal OpenAI Chat Completions request with streaming disabled for readability.",
      code: `curl ${base}/chat/completions \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer ${config.gateway.apiKey}' \\\n  -d '${JSON.stringify({ model, messages: [{ role: "user", content: "Write hello world in Rust." }], stream: false })}'`
    }
  }), [base, config.gateway.apiKey, config.server.contextTokens, config.server.maxOutputTokens, isQwen, model, root]);

  const connectors = adapterMeta.map((item) => {
    const compatibility = isQwen ? getQwenAdapterCompatibility(item.id) : { available: true, unavailableReason: null };
    return {
      ...item,
      compatibility,
      displayName: isQwen && item.id === "generic" ? "Chat Completions" : item.name,
      snippet: snippets[item.id]
    };
  });
  const availableConnectors = connectors.filter((item) => item.compatibility.available);
  const unavailableConnectors = connectors.filter((item) => !item.compatibility.available);

  const testConnection = async () => {
    if (connection.state !== "ready") return;
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

  const endpoints = isQwen
    ? [
        { label: "Chat Completions", protocol: "OpenAI API · tools and streaming", url: `${base}/chat/completions`, icon: MessagesSquare },
        { label: "Gateway status", protocol: "Model availability", url: `${base}/models`, icon: Zap }
      ]
    : [
        { label: "OpenAI", protocol: "Codex and compatible apps", url: base, icon: MessagesSquare },
        { label: "Anthropic", protocol: "Claude Code", url: root, icon: Bot },
        { label: "Status", protocol: "Availability check", url: `${base}/models`, icon: Zap }
      ];

  return (
    <div className="agents-page page-scroll">
      <section className="agents-intro">
        <div>
          <h2>{isQwen ? "Connect through Chat Completions." : "Connect your preferred coding agent."}</h2>
          <p>{isQwen ? "Use Hebrus Studio Chat or connect compatible apps and coding agents through OpenAI Chat Completions with streaming, tools, and multiple tool calls." : "Choose your tool and copy the ready-to-use configuration. Hebrus Studio handles the address, model, and security."}</p>
        </div>
        <div className="agents-intro__status panel">
          <StatusPill phase={runtime.phase} />
          <div><span>Address</span><strong>{system.gatewayBaseUrl.replace("http://", "")}</strong></div>
          <button
            className={testResult === "error" ? "connection-test--error" : ""}
            onClick={() => connection.state === "offline" ? onNavigate("runtime") : void testConnection()}
            disabled={testing || connection.state === "loading"}
            aria-live="polite"
          >
            {connection.state === "loading" || testing
              ? <RefreshCw size={14} className="spin" />
              : testResult === "ok"
                ? <CircleCheck size={14} />
                : testResult === "error"
                  ? <Unplug size={14} />
                  : <Play size={14} />}
            {connection.state !== "ready"
              ? connection.actionLabel
              : testing
                ? "Checking…"
                : testResult === "ok"
                  ? (isQwen ? "Gateway ready" : "Ready")
                  : testResult === "error"
                    ? "Unavailable"
                    : connection.actionLabel}
          </button>
        </div>
      </section>

      {testResult === "error" && (
        <div className="connection-error" role="alert">
          <Unplug size={17} />
          <div>
            <strong>{runtime.phase === "running" ? "Gateway unavailable" : "Hebrus Server is off"}</strong>
            <p>{runtime.phase === "running" ? "Check the server status and try again." : "Turn on the server, then test the connection again."}</p>
          </div>
          <Button variant="secondary" onClick={() => onNavigate("runtime")}>Open server</Button>
        </div>
      )}

      {isQwen && (
        <section className={`qwen-capability qwen-capability--${connection.state} panel`} aria-label="Qwen connection capabilities">
          <span className="qwen-capability__icon"><MessagesSquare size={17} /></span>
          <div>
            <div><strong>{connection.capabilityTitle}</strong><span>{connection.capabilityBadge}</span></div>
            <p>{connection.capabilityDescription}</p>
          </div>
        </section>
      )}

      <section className={`endpoint-grid ${isQwen ? "endpoint-grid--compact" : ""}`}>
        {endpoints.map((endpoint) => {
          const Icon = endpoint.icon;
          return (
            <article className="endpoint-card panel" key={endpoint.label}>
              <span className="endpoint-card__icon"><Icon size={17} /></span>
              <div><strong>{endpoint.label}</strong><small>{endpoint.protocol}</small><code>{endpoint.url}</code></div>
              <CopyButton value={endpoint.url} label={`Copy ${endpoint.label} URL`} />
            </article>
          );
        })}
      </section>

      <section className="agent-configs" aria-labelledby="agent-configs-title">
        <div className="agent-configs__head">
          <div>
            <h3 id="agent-configs-title">Agent configurations</h3>
            <p>Copy the block for the tool you use. Every available connector is shown here, ordered by protocol fit.</p>
          </div>
          <div className="connector-list__note"><ShieldCheck size={15} /><p>{isQwen ? "Protocol limits come from the selected Hebrus model runtime." : "The internal server is never exposed to the network."}</p></div>
        </div>

        <div className="agent-config-grid">
          {availableConnectors.map((item) => {
            const Icon = item.icon;
            const current = item.snippet;
            return (
              <article
                className="agent-config-card panel"
                key={item.id}
              >
                <div className="agent-config-card__head">
                  <span className="agent-config-card__icon"><Icon size={18} /></span>
                  <div className="agent-config-card__copy">
                    <span className="connector-file">{current.file}</span>
                    <h4>{item.displayName}</h4>
                    <p>{current.description}</p>
                  </div>
                  <div className="agent-config-card__actions">
                    <span>{item.detail}</span>
                    <CopyButton value={current.code} label={`Copy ${item.displayName} configuration`} />
                  </div>
                </div>
                <div className="code-window">
                  <div className="code-window__bar"><i /><i /><i /><span>{current.file}</span></div>
                  <pre><code>{current.code}</code></pre>
                </div>
                {current.run && (
                  <div className="run-command"><TerminalSquare size={15} /><code>{current.run}</code><CopyButton value={current.run} label="Copy command" /></div>
                )}
              </article>
            );
          })}
        </div>

        {unavailableConnectors.length > 0 && (
          <div className="agent-unavailable" aria-label="Unavailable agent protocols">
            <div className="agent-unavailable__head">
              <strong>Unavailable for this runtime</strong>
              <span>{unavailableConnectors.length}</span>
            </div>
            <div className="agent-unavailable__grid">
              {unavailableConnectors.map((item) => {
                const Icon = item.icon;
                return (
                  <article key={item.id} className="agent-unavailable-card">
                    <span><Icon size={16} /></span>
                    <div>
                      <strong>{item.name}</strong>
                      <p>{item.compatibility.unavailableReason}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section className="agent-notes">
        <article className="panel">
          <span><KeyRound size={17} /></span>
          <div><strong>Local authentication</strong><p>{config.gateway.requireApiKey ? "The gateway requires the token shown in Settings." : "The key is a placeholder because the gateway is restricted to 127.0.0.1."}</p></div>
        </article>
        <article className="panel">
          <span><ShieldCheck size={17} /></span>
          <div><strong>{isQwen ? "Live context" : "Faster starts"}</strong><p>{isQwen ? "Qwen can reuse the active conversation while Hebrus Studio stays on; disk context snapshots are not available yet." : "Hebrus Studio can reuse previously processed context instead of starting from scratch every time."}</p></div>
        </article>
        <article className="panel">
          <span><Network size={17} /></span>
          <div><strong>Queued requests</strong><p>When multiple requests arrive at once, Hebrus Studio processes them in sequence to remain stable.</p></div>
        </article>
      </section>

      <div className="compatibility-note"><CircleAlert size={14} /><p>{isQwen ? "Qwen3.6 supports Hebrus Studio Chat and OpenAI-compatible Chat Completions with tools; Codex and Claude Code require protocols this runtime does not expose." : "These configuration snippets automatically use the model selected in Hebrus Studio."}</p></div>
    </div>
  );
}
