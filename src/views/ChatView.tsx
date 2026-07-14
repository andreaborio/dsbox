import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Code2,
  Cpu,
  Database,
  Gauge,
  Globe2,
  HardDrive,
  Hash,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  Timer,
  Trash2,
  Zap
} from "lucide-react";
import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { AppSnapshot, ChatMessage, LocalModelCandidate, LocalModelSwitchResult, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { useChatSession } from "../hooks/useChatSession";
import { BrandMark, Button, CopyButton, Modal } from "../components/ui";
import { DsboxOrb, type DsboxOrbState } from "../components/DsboxOrb";
import { apiRequest } from "../lib/api";
import { formatBytes, formatModelName } from "../lib/format";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

const suggestions = [
  { icon: Code2, title: "Explore a codebase", prompt: "Help me understand a codebase and identify the most important areas to read first." },
  { icon: Database, title: "Design a system", prompt: "Design a robust architecture, explain the trade-offs, and provide a concrete implementation plan." },
  { icon: Cpu, title: "Optimize a hot path", prompt: "Analyze this workload's bottlenecks and propose measurable experiments." }
];

type LiveInferenceStage = DsboxOrbState;
type MessageStageState = LiveInferenceStage | "error" | "off" | "ready" | "preparing";

function liveInferenceStage(message: ChatMessage, skillStage: "idle" | "searching"): LiveInferenceStage | null {
  if (!message.pending || message.error || message.interrupted || skillStage === "searching") return null;
  if (message.content) return "decode";
  if (message.reasoning) return "thinking";
  return "prefill";
}

function AssistantAvatar({ state }: { state: LiveInferenceStage | null }) {
  return (
    <div className="message__avatar">
      {state ? <DsboxOrb state={state} decorative /> : <BrandMark small />}
    </div>
  );
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${rate.toFixed(rate < 10 ? 2 : 1)} t/s`;
}

function relativeTime(timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp);
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(timestamp);
}

function safeSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function sourceHost(url: string): string {
  const safe = safeSourceUrl(url);
  return safe ? new URL(safe).hostname.replace(/^www\./, "") : "Source";
}

function revealTextChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child, childIndex) => {
    if (typeof child !== "string") return child;
    return child.split(/(\s+)/).map((part, partIndex) => {
      if (!part || /^\s+$/.test(part)) return part;
      return <span className="stream-word" key={`${childIndex}-${partIndex}-${part}`}>{part}</span>;
    });
  });
}

function nodeText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement<{ children?: ReactNode }>(child)) return "";
    return nodeText(child.props.children);
  }).join("");
}

const CodeBlock: NonNullable<Components["pre"]> = ({ children, node: _node, ...props }) => {
  const codeElement = Children.toArray(children).find((child) => isValidElement<{ className?: string }>(child));
  const className = isValidElement<{ className?: string }>(codeElement) ? codeElement.props.className ?? "" : "";
  const language = className.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const code = nodeText(children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <div className="code-block__toolbar">
        <span>{language ? language.replace(/[-_]/g, " ") : "Code"}</span>
        <CopyButton value={code} label="Copy" />
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
};

const markdownComponents: Components = { pre: CodeBlock };

const streamingMarkdownComponents: Components = {
  ...markdownComponents,
  p: ({ children, node: _node, ...props }) => <p {...props}>{revealTextChildren(children)}</p>,
  li: ({ children, node: _node, ...props }) => <li {...props}>{revealTextChildren(children)}</li>,
  h1: ({ children, node: _node, ...props }) => <h1 {...props}>{revealTextChildren(children)}</h1>,
  h2: ({ children, node: _node, ...props }) => <h2 {...props}>{revealTextChildren(children)}</h2>,
  h3: ({ children, node: _node, ...props }) => <h3 {...props}>{revealTextChildren(children)}</h3>,
  blockquote: ({ children, node: _node, ...props }) => <blockquote {...props}>{revealTextChildren(children)}</blockquote>,
  td: ({ children, node: _node, ...props }) => <td {...props}>{revealTextChildren(children)}</td>,
  th: ({ children, node: _node, ...props }) => <th {...props}>{revealTextChildren(children)}</th>
};

export function ChatView({ snapshot, controller, onNavigate }: Props) {
  const chat = useChatSession();
  const { messages, input, thinking, streaming } = chat;
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [localModels, setLocalModels] = useState<LocalModelCandidate[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [switchingPath, setSwitchingPath] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const wasStreamingRef = useRef(streaming);
  const reduceMotion = useReducedMotion();

  const loadLocalModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const response = await apiRequest<{ models: LocalModelCandidate[] }>("/api/models/local");
      setLocalModels(response.models);
      setModelError(null);
    } catch (reason) {
      setModelError(reason instanceof Error ? reason.message : "Installed models could not be loaded");
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLocalModels();
  }, [loadLocalModels, snapshot.config.model.path]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (modelMenuRef.current?.contains(event.target as Node)) return;
      setModelMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModelMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [streaming]);

  const scrollToLatest = (smooth = false) => {
    const element = scrollRef.current;
    if (!element) return;
    autoScrollRef.current = true;
    setShowJump(false);
    element.scrollTo({ top: element.scrollHeight, behavior: smooth && !reduceMotion ? "smooth" : "auto" });
  };

  const latestAssistantContent = [...messages].reverse().find((message) => message.role === "assistant");

  useEffect(() => {
    if (!autoScrollRef.current) return;
    const frame = window.requestAnimationFrame(() => scrollToLatest(false));
    return () => window.cancelAnimationFrame(frame);
  }, [chat.activeThreadId, latestAssistantContent?.content, latestAssistantContent?.reasoning, latestAssistantContent?.pending, latestAssistantContent?.sources?.length]);

  const ready = snapshot.runtime.readiness === "ready";
  const preparing = ["preparing", "installing", "updating", "building", "downloading", "starting"].includes(snapshot.runtime.phase);
  const stopping = snapshot.runtime.phase === "stopping";
  const runtimeError = snapshot.runtime.phase === "error";
  const empty = messages.length === 0;
  const selectedLocalModel = localModels.find((model) => model.selected || model.path === snapshot.config.model.path);
  const currentModelLabel = formatModelName(selectedLocalModel?.modelId || snapshot.config.model.id);
  const modelSwitching = switchingPath !== null;
  const modelSwitchBlocked = streaming
    || modelSwitching
    || !["uninstalled", "idle", "running", "error"].includes(snapshot.runtime.phase);

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = streaming;
    if (!wasStreaming || streaming || !ready) return;
    const frame = window.requestAnimationFrame(() => textAreaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [ready, streaming]);

  const runtimePresentation = ready
    ? {
        description: "The model runs on your Mac. Your prompts, cache, and code stay local.",
        notice: "DSBox is ready",
        detail: "you can start typing",
        placeholder: "Message DSBox…"
      }
    : runtimeError
      ? {
          description: "DSBox needs your attention. Open Server to see what happened and try again.",
          notice: "DSBox needs attention",
          detail: "open Server to resolve it",
          placeholder: "Check the server status…"
        }
      : stopping
        ? {
            description: "DSBox is safely closing the local session.",
            notice: "Turning off DSBox",
            detail: "this will only take a moment",
            placeholder: "DSBox is shutting down…"
          }
        : preparing
          ? {
              description: "Preparing the model on your Mac. Your prompts, cache, and code will stay local.",
              notice: "Preparing DSBox",
              detail: "follow the progress in Server",
              placeholder: "DSBox is getting ready…"
            }
          : {
              description: "When you turn on DSBox, the model, prompts, cache, and code stay on your Mac.",
              notice: "DSBox is off",
              detail: "turn it on to get started",
              placeholder: "Turn on DSBox to chat…"
            };

  const sortedThreads = useMemo(() => [...chat.threads].sort((left, right) => right.updatedAt - left.updatedAt), [chat.threads]);
  const activeThread = chat.threads.find((thread) => thread.id === chat.activeThreadId) ?? chat.threads[0];

  const switchInstalledModel = async (model: LocalModelCandidate) => {
    if (modelSwitchBlocked || model.selected || model.path === snapshot.config.model.path) {
      setModelMenuOpen(false);
      return;
    }
    setSwitchingPath(model.path);
    setModelError(null);
    setModelMenuOpen(false);
    try {
      const result = await apiRequest<LocalModelSwitchResult>("/api/models/local/switch", {
        method: "POST",
        body: JSON.stringify({ path: model.path, modelId: model.modelId })
      });
      setLocalModels((current) => current.map((candidate) => ({
        ...candidate,
        selected: candidate.path === result.model.path
      })));
      await controller.refresh();
    } catch (reason) {
      setModelError(reason instanceof Error ? reason.message : "The model could not be switched");
      setModelMenuOpen(true);
    } finally {
      setSwitchingPath(null);
    }
  };

  const send = (event?: FormEvent, suggested?: string) => {
    event?.preventDefault();
    const content = (suggested ?? input).trim();
    if (!content || streaming || modelSwitching) return;
    if (!ready) {
      onNavigate("runtime");
      return;
    }
    autoScrollRef.current = true;
    setShowJump(false);
    void chat.send({ content, model: snapshot.config.model.id, maxTokens: snapshot.config.server.maxOutputTokens });
    if (textAreaRef.current) textAreaRef.current.style.height = "auto";
  };

  const startNewThread = () => {
    if (streaming) return;
    chat.newThread();
    setReasoningOpen({});
    setHistoryOpen(false);
    autoScrollRef.current = true;
    window.requestAnimationFrame(() => textAreaRef.current?.focus());
  };

  const resizeComposer = () => {
    const element = textAreaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  };

  const messageStage = (message: ChatMessage): { state: MessageStageState; label: string } => {
    if (message.error) return { state: "error", label: "Needs attention" };
    if (message.interrupted) return { state: "off", label: "Generation stopped" };
    if (!message.pending) return { state: "ready", label: "Complete" };
    if (chat.skillStage === "searching") return { state: "preparing", label: "Web search · Finding sources" };
    if (message.content) return { state: "decode", label: "Decode · Writing" };
    if (message.reasoning) return { state: "thinking", label: "Thinking · Reasoning" };
    return { state: "prefill", label: "Prefill · Reading context" };
  };

  const stageElapsed = (message: ChatMessage): number | null => {
    if (!message.pending || !message.stats) return null;
    if (message.content) return now - (message.stats.answerStartedAt ?? message.stats.firstTokenAt ?? message.stats.startedAt);
    if (message.reasoning) return now - (message.stats.reasoningStartedAt ?? message.stats.firstTokenAt ?? message.stats.startedAt);
    return now - message.stats.startedAt;
  };

  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const liveStatus = latestAssistant
    ? latestAssistant.pending
      ? `DSBox: ${messageStage(latestAssistant).label}`
      : latestAssistant.error
        ? "The response failed."
        : latestAssistant.interrupted
          ? "Generation stopped."
          : "Response complete."
    : "";

  return (
    <div className={`chat-layout ${empty ? "chat-layout--empty" : ""} ${!ready ? "chat-layout--runtime-blocked" : ""}`}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</div>
      <div className="chat-toolbar">
        <button className="chat-toolbar__history" onClick={() => { setNow(Date.now()); setHistoryOpen(true); }}>
          <History size={14} />
          <span>Chats</span>
          <small>{chat.threads.length}</small>
        </button>
        <div className="chat-toolbar__thread" title={activeThread.title}>{activeThread.title}</div>
      </div>

      <div
        className="chat-scroll"
        ref={scrollRef}
        role="region"
        aria-label="Conversation messages"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
          autoScrollRef.current = atBottom;
          setShowJump(!atBottom);
        }}
      >
        <AnimatePresence mode="popLayout">
          {empty ? (
            <motion.div
              className="chat-empty"
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24 }}
            >
              <BrandMark />
              <h2>What do you want to build?</h2>
              <p>{runtimePresentation.description}</p>
              <div className="suggestion-grid">
                {suggestions.map((suggestion, index) => {
                  const Icon = suggestion.icon;
                  return (
                    <motion.button
                      key={suggestion.title}
                      className="suggestion-card"
                      onClick={() => void send(undefined, suggestion.prompt)}
                      initial={reduceMotion ? false : { opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.03 + index * 0.025, duration: 0.16 }}
                    >
                      <span><Icon size={17} /></span>
                      <strong>{suggestion.title}</strong>
                      <p>{suggestion.prompt}</p>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          ) : (
            <div className="message-list" role="log" aria-live="off" aria-label="Conversation">
              {messages.map((message) => (
                <motion.article
                  key={message.id}
                  className={`message message--${message.role} ${message.error ? "message--error" : ""}`}
                  aria-label={message.role === "user" ? "You" : "DSBox"}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  {message.role === "assistant" && (
                    <AssistantAvatar state={liveInferenceStage(message, chat.skillStage)} />
                  )}
                  <div className="message__body">
                    {message.role === "assistant" && message.pending && (
                      <div className={`message-stage message-stage--${messageStage(message).state}`}>
                        <span />
                        <strong>{messageStage(message).label}</strong>
                        {stageElapsed(message) !== null && <time>{formatDuration(stageElapsed(message))}</time>}
                      </div>
                    )}
                    {message.reasoning && (
                      <div className={`reasoning ${reasoningOpen[message.id] ? "reasoning--open" : ""}`}>
                        <button onClick={() => setReasoningOpen((current) => ({ ...current, [message.id]: !current[message.id] }))} aria-expanded={Boolean(reasoningOpen[message.id])}>
                          <Brain size={14} />
                          <span>Reasoning</span>
                          {message.pending && <span className="reasoning__live">live</span>}
                          <ChevronDown className="reasoning__chevron" size={13} />
                        </button>
                        {reasoningOpen[message.id] && <p>{message.reasoning}</p>}
                      </div>
                    )}
                    {message.skillNotice && <div className="message-skill-notice"><Globe2 size={12} /><span>{message.skillNotice}</span></div>}
                    {message.content ? (
                      <div className="markdown-body">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
                          components={message.pending ? streamingMarkdownComponents : markdownComponents}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    ) : message.interrupted ? (
                      <div className="generation-stopped-copy">Generation stopped before output began.</div>
                    ) : message.pending ? (
                      <div className="typing"><i /><i /><i /></div>
                    ) : null}
                    {message.pending && message.content && <span className="stream-caret" />}
                    {message.role === "assistant" && message.interrupted && !message.pending && !message.error && (
                      <div className="message__complete message__complete--interrupted">
                        <CircleStop size={12} /> Stopped
                      </div>
                    )}
                    {message.role === "assistant" && message.stats && !message.pending && (
                      <details
                        className="response-stats"
                        onToggle={(event) => {
                          const details = event.currentTarget;
                          if (!details.open) return;
                          window.requestAnimationFrame(() => {
                            const scroller = scrollRef.current;
                            const composer = details.closest(".chat-layout")?.querySelector<HTMLElement>(".composer-wrap");
                            if (!scroller || !composer) return;
                            const overflow = details.getBoundingClientRect().bottom - composer.getBoundingClientRect().top + 12;
                            if (overflow > 0) scroller.scrollBy({ top: overflow, behavior: reduceMotion ? "auto" : "smooth" });
                          });
                        }}
                      >
                        <summary aria-label="Open response performance details">
                          {message.stats.averageTokensPerSecond !== null && <span title="Average across reasoning and answer"><Zap size={11} /><strong>{formatRate(message.stats.averageTokensPerSecond)}</strong><small>generation</small></span>}
                          {message.stats.totalTokens !== null && <span><Hash size={11} /><strong>{message.stats.totalTokens.toLocaleString("en-US")}</strong><small>tokens</small></span>}
                          {(message.stats.prefillTokensPerSecond !== null || message.stats.prefillMs !== null) && (
                            <span><Gauge size={11} /><strong>{message.stats.prefillTokensPerSecond !== null ? formatRate(message.stats.prefillTokensPerSecond) : formatDuration(message.stats.prefillMs)}</strong><small>prefill</small></span>
                          )}
                          {message.stats.totalMs !== null && <span><Timer size={11} /><strong>{formatDuration(message.stats.totalMs)}</strong><small>total</small></span>}
                          <ChevronDown className="response-stats__chevron" size={12} />
                        </summary>
                        <dl className="response-stats__details">
                          {message.stats.promptTokens !== null && <div><dt>Prompt</dt><dd>{message.stats.promptTokens.toLocaleString("en-US")} tokens</dd></div>}
                          {message.stats.cachedPromptTokens !== null && <div><dt>Cached prompt</dt><dd>{message.stats.cachedPromptTokens.toLocaleString("en-US")} tokens</dd></div>}
                          {message.stats.completionTokens !== null && <div><dt>Generated</dt><dd>{message.stats.completionTokens.toLocaleString("en-US")} tokens</dd></div>}
                          {message.stats.prefillMs !== null && <div><dt>Prefill latency</dt><dd>{formatDuration(message.stats.prefillMs)}</dd></div>}
                          {message.stats.thinkingMs !== null && <div><dt>Thinking</dt><dd>{formatDuration(message.stats.thinkingMs)}{message.stats.reasoningTokens !== null ? ` · ${message.stats.reasoningTokens.toLocaleString("en-US")} tokens` : ""}</dd></div>}
                          {message.stats.decodeMs !== null && <div><dt>Generation</dt><dd>{formatDuration(message.stats.decodeMs)}</dd></div>}
                          {message.stats.webSearchMs !== null && <div><dt>Web search</dt><dd>{formatDuration(message.stats.webSearchMs)}</dd></div>}
                          <div><dt>Timing</dt><dd>{message.stats.timingSource === "server" ? "Reported by DS4" : "Measured end to end"}</dd></div>
                        </dl>
                      </details>
                    )}
                    {message.role === "assistant" && message.sources?.length ? (
                      <div className="message-sources">
                        <div className="message-sources__head"><Globe2 size={13} /><strong>Sources</strong><span>{message.sources.length}</span></div>
                        <div className="message-sources__grid">
                          {message.sources.map((source, index) => {
                            const href = safeSourceUrl(source.url);
                            if (!href) return null;
                            return <a key={`${source.url}-${index}`} href={href} target="_blank" rel="noreferrer noopener" title={source.snippet}><i>{index + 1}</i><span><strong>{source.title}</strong><small>{sourceHost(source.url)}</small></span></a>;
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </motion.article>
              ))}
            </div>
          )}
        </AnimatePresence>
      </div>

      {showJump && !empty && <button className="chat-jump" onClick={() => scrollToLatest(true)}><ChevronDown size={15} /> Jump to latest</button>}

      <div className="composer-wrap">
        {!ready && (
          <button className={`runtime-notice ${runtimeError ? "runtime-notice--error" : ""}`} onClick={() => onNavigate("runtime")}>
            <span className="runtime-notice__dot" />
            <span><strong>{runtimePresentation.notice}</strong> · {runtimePresentation.detail}</span>
            <ChevronRight size={14} />
          </button>
        )}
        <form className={`composer ${streaming ? "composer--streaming" : ""}`} onSubmit={(event) => void send(event)}>
          <textarea
            ref={textAreaRef}
            value={input}
            onChange={(event) => { chat.setInput(event.target.value); resizeComposer(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                event.preventDefault();
                void send();
              }
            }}
            placeholder={ready ? "Message DSBox…" : runtimePresentation.placeholder}
            aria-label="Message"
            rows={1}
            disabled={!ready || streaming || modelSwitching}
          />
          <div className="composer__footer">
            <div className="composer__tool-group">
              <div className="model-picker" ref={modelMenuRef}>
                <button
                  type="button"
                  className="model-picker__trigger"
                  onClick={() => {
                    const opening = !modelMenuOpen;
                    setModelMenuOpen(opening);
                    if (opening) void loadLocalModels();
                  }}
                  disabled={modelSwitchBlocked}
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  title={streaming ? "Stop the active generation before switching models" : "Switch installed model"}
                >
                  {modelSwitching ? <LoaderCircle className="spin" size={13} /> : <HardDrive size={13} />}
                  <span>{modelSwitching ? "Switching model…" : currentModelLabel}</span>
                  <ChevronDown size={12} />
                </button>
                <AnimatePresence>
                  {modelMenuOpen && (
                    <motion.div
                      className="model-picker__menu"
                      role="dialog"
                      aria-label="Installed models"
                      initial={reduceMotion ? false : { opacity: 0, y: 5, scale: 0.985 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 3, scale: 0.99 }}
                      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <div className="model-picker__head">
                        <span>Installed models</span>
                        <button type="button" onClick={() => void loadLocalModels()} disabled={modelsLoading} aria-label="Refresh installed models" title="Refresh installed models">
                          <RefreshCw className={modelsLoading ? "spin" : ""} size={13} />
                        </button>
                      </div>
                      {modelError && <div className="model-picker__error" role="alert">{modelError}</div>}
                      <div className="model-picker__list" role="radiogroup" aria-label="Choose an installed model">
                        {modelsLoading && localModels.length === 0 ? (
                          <div className="model-picker__empty"><LoaderCircle className="spin" size={14} /> Checking this Mac…</div>
                        ) : localModels.length === 0 ? (
                          <div className="model-picker__empty">No installed GGUF models found.</div>
                        ) : localModels.map((model) => {
                          const selected = model.selected || model.path === snapshot.config.model.path;
                          return (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className={`model-picker__item ${selected ? "model-picker__item--active" : ""}`}
                              key={model.path}
                              onClick={() => void switchInstalledModel(model)}
                              disabled={modelSwitching}
                              title={model.path}
                            >
                              <span className="model-picker__item-icon"><HardDrive size={14} /></span>
                              <span className="model-picker__item-copy">
                                <strong>{formatModelName(model.modelId)}</strong>
                                <small>{model.name} · {formatBytes(model.sizeBytes, 1)}</small>
                              </span>
                              {selected && <Check size={14} />}
                            </button>
                          );
                        })}
                      </div>
                      <div className="model-picker__foot">
                        <span>Switching restarts DS4 when it is on.</span>
                        <button type="button" onClick={() => { setModelMenuOpen(false); onNavigate("models"); }}>Manage models</button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <button type="button" className={`thinking-toggle ${thinking ? "thinking-toggle--on" : ""}`} onClick={() => chat.setThinking(!thinking)} aria-pressed={thinking}>
                <Brain size={13} /> <span>Thinking</span><i aria-hidden="true" />
              </button>
            </div>
            {streaming ? (
              <Button type="button" variant="primary" className="send-button send-button--stop" icon={<CircleStop size={16} />} onClick={chat.stop}>Stop</Button>
            ) : (
              <button className="send-button" type="submit" disabled={!ready || modelSwitching || !input.trim()} aria-label="Send">
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </form>
      </div>

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Local threads"
        footer={<><span className="thread-history__local">Stored only in this browser on this Mac.</span><Button variant="primary" icon={<Plus size={14} />} disabled={streaming} onClick={startNewThread}>New thread</Button></>}
      >
        <div className="thread-history">
          {streaming && <div className="thread-history__notice"><CircleStop size={14} /><span>Stop the active generation before switching threads.</span></div>}
          <div className="thread-history__list">
            {sortedThreads.map((thread) => {
              const lastMessage = [...thread.messages].reverse().find((message) => message.content.trim());
              const selected = thread.id === activeThread.id;
              return (
                <div key={thread.id} className={`thread-row ${selected ? "thread-row--active" : ""}`}>
                  <button
                    className="thread-row__select"
                    disabled={streaming && !selected}
                    onClick={() => {
                      if (selected || chat.selectThread(thread.id)) setHistoryOpen(false);
                      autoScrollRef.current = true;
                    }}
                    aria-current={selected ? "true" : undefined}
                  >
                    <span><strong>{thread.title}</strong><time>{relativeTime(thread.updatedAt, now)}</time></span>
                    <p>{lastMessage?.content || "Empty thread"}</p>
                  </button>
                  <button className="thread-row__delete" disabled={streaming} onClick={() => chat.deleteThread(thread.id)} aria-label={`Delete ${thread.title}`} title="Delete thread"><Trash2 size={14} /></button>
                </div>
              );
            })}
          </div>
        </div>
      </Modal>
    </div>
  );
}
