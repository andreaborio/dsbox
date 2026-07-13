import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  CircleStop,
  Code2,
  Cpu,
  Database,
  Gauge,
  Globe2,
  Hash,
  History,
  Plus,
  Sparkles,
  Timer,
  Trash2,
  Zap
} from "lucide-react";
import { Children, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppSnapshot, ChatMessage, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { useChatSession } from "../hooks/useChatSession";
import { Button, Modal } from "../components/ui";
import { DsboxOrb, type DsboxOrbState } from "../components/DsboxOrb";
import { formatModelName } from "../lib/format";

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

const streamingMarkdownComponents: Components = {
  p: ({ children, node: _node, ...props }) => <p {...props}>{revealTextChildren(children)}</p>,
  li: ({ children, node: _node, ...props }) => <li {...props}>{revealTextChildren(children)}</li>,
  h1: ({ children, node: _node, ...props }) => <h1 {...props}>{revealTextChildren(children)}</h1>,
  h2: ({ children, node: _node, ...props }) => <h2 {...props}>{revealTextChildren(children)}</h2>,
  h3: ({ children, node: _node, ...props }) => <h3 {...props}>{revealTextChildren(children)}</h3>,
  blockquote: ({ children, node: _node, ...props }) => <blockquote {...props}>{revealTextChildren(children)}</blockquote>,
  td: ({ children, node: _node, ...props }) => <td {...props}>{revealTextChildren(children)}</td>,
  th: ({ children, node: _node, ...props }) => <th {...props}>{revealTextChildren(children)}</th>
};

export function ChatView({ snapshot, onNavigate }: Props) {
  const chat = useChatSession();
  const { messages, input, thinking, streaming } = chat;
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [now, setNow] = useState(Date.now);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const reduceMotion = useReducedMotion();

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
  const runtimePresentation = ready
    ? {
        orb: "ready" as DsboxOrbState,
        description: "The model runs on your Mac. Your prompts, cache, and code stay local.",
        notice: "DSBox is ready",
        detail: "you can start typing",
        placeholder: "Message DSBox…"
      }
    : runtimeError
      ? {
          orb: "error" as DsboxOrbState,
          description: "DSBox needs your attention. Open Server to see what happened and try again.",
          notice: "DSBox needs attention",
          detail: "open Server to resolve it",
          placeholder: "Check the server status…"
        }
      : stopping
        ? {
            orb: "preparing" as DsboxOrbState,
            description: "DSBox is safely closing the local session.",
            notice: "Turning off DSBox",
            detail: "this will only take a moment",
            placeholder: "DSBox is shutting down…"
          }
        : preparing
          ? {
              orb: "preparing" as DsboxOrbState,
              description: "Preparing the model on your Mac. Your prompts, cache, and code will stay local.",
              notice: "Preparing DSBox",
              detail: "follow the progress in Server",
              placeholder: "DSBox is getting ready…"
            }
          : {
              orb: "off" as DsboxOrbState,
              description: "When you turn on DSBox, the model, prompts, cache, and code stay on your Mac.",
              notice: "DSBox is off",
              detail: "turn it on to get started",
              placeholder: "Turn on DSBox to chat…"
            };

  const sortedThreads = useMemo(() => [...chat.threads].sort((left, right) => right.updatedAt - left.updatedAt), [chat.threads]);
  const activeThread = chat.threads.find((thread) => thread.id === chat.activeThreadId) ?? chat.threads[0];

  const send = (event?: FormEvent, suggested?: string) => {
    event?.preventDefault();
    const content = (suggested ?? input).trim();
    if (!content || streaming) return;
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
  };

  const resizeComposer = () => {
    const element = textAreaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  };

  const messageStage = (message: ChatMessage): { state: DsboxOrbState; label: string } => {
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
            <span>Threads</span>
            <small>{chat.threads.length}</small>
          </button>
          <div className="chat-toolbar__model"><span className="mini-orb" /><span>{formatModelName(snapshot.config.model.id)}</span></div>
          <div className="chat-toolbar__thread" title={activeThread.title}>{activeThread.title}</div>
          <button className={`thinking-chip ${thinking ? "thinking-chip--on" : ""}`} onClick={() => chat.setThinking(!thinking)} aria-pressed={thinking}>
            <Brain size={14} />
            {thinking ? "Thinking" : "Direct answer"}
          </button>
      </div>

      <div
        className="chat-scroll"
        ref={scrollRef}
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
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
            >
              <DsboxOrb state={runtimePresentation.orb} size="md" />
              <div className="eyebrow chat-empty__model"><Sparkles size={13} /><span>{formatModelName(snapshot.config.model.id)} · on your Mac</span></div>
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
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.04 + index * 0.03, duration: 0.18 }}
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
                  layout
                  key={message.id}
                  className={`message message--${message.role} ${message.error ? "message--error" : ""}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  {message.role === "assistant" && (
                    <div className="message__avatar"><DsboxOrb state={messageStage(message).state} size="sm" decorative /></div>
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
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={message.pending ? streamingMarkdownComponents : undefined}>{message.content}</ReactMarkdown>
                      </div>
                    ) : message.interrupted ? (
                      <div className="generation-stopped-copy">Generation stopped before output began.</div>
                    ) : message.pending ? (
                      <div className="typing"><i /><i /><i /></div>
                    ) : null}
                    {message.pending && message.content && <span className="stream-caret" />}
                    {message.role === "assistant" && !message.pending && !message.error && (
                      <div className={`message__complete ${message.interrupted ? "message__complete--interrupted" : ""}`}>
                        {message.interrupted ? <CircleStop size={12} /> : <Check size={12} />}
                        {message.interrupted ? "Stopped" : "Local"}
                      </div>
                    )}
                    {message.role === "assistant" && message.stats && !message.pending && (
                      <div className="response-stats" aria-label="Response statistics">
                        {message.stats.averageTokensPerSecond !== null && <span title="Average decode speed"><Zap size={12} /><strong>{formatRate(message.stats.averageTokensPerSecond)}</strong><small>average</small></span>}
                        {message.stats.totalTokens !== null && <span title={`${message.stats.promptTokens ?? 0} prompt tokens · ${message.stats.completionTokens ?? 0} completion tokens`}><Hash size={12} /><strong>{message.stats.totalTokens.toLocaleString("en-US")}</strong><small>total tokens</small></span>}
                        {typeof message.stats.webSearchMs === "number" && <span title="Time spent gathering current web sources"><Globe2 size={12} /><strong>{formatDuration(message.stats.webSearchMs)}</strong><small>web search</small></span>}
                        <span title="Server-reported prefill timing when available; otherwise end-to-end time to first token"><Gauge size={12} /><strong>{formatDuration(message.stats.prefillMs)}</strong>{message.stats.prefillTokensPerSecond !== null && <b>{formatRate(message.stats.prefillTokensPerSecond)}</b>}<small>prefill</small></span>
                        {message.stats.thinkingMs !== null && <span title={message.stats.reasoningTokens !== null ? `${message.stats.reasoningTokens} reasoning tokens` : "Time spent streaming reasoning"}><Brain size={12} /><strong>{formatDuration(message.stats.thinkingMs)}</strong><small>thinking</small></span>}
                        <span title="Total end-to-end response time"><Timer size={12} /><strong>{formatDuration(message.stats.totalMs)}</strong><small>total</small></span>
                      </div>
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
            <ArrowUp size={14} />
          </button>
        )}
        <form className={`composer ${streaming ? "composer--streaming" : ""}`} onSubmit={(event) => void send(event)}>
          <textarea
            ref={textAreaRef}
            value={input}
            onChange={(event) => { chat.setInput(event.target.value); resizeComposer(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={ready ? "Message DSBox — Enter to send, Shift+Enter for a new line" : runtimePresentation.placeholder}
            aria-label="Message"
            rows={1}
            disabled={!ready || streaming}
          />
          <div className="composer__footer">
            <div className="composer__tool-group">
              <button type="button" className={`thinking-toggle ${thinking ? "thinking-toggle--on" : ""}`} onClick={() => chat.setThinking(!thinking)} aria-pressed={thinking}>
                <Brain size={15} /> {thinking ? "Thinking" : "Direct answer"}
              </button>
            </div>
            {streaming ? (
              <Button type="button" variant="primary" className="send-button send-button--stop" icon={<CircleStop size={16} />} onClick={chat.stop}>Stop</Button>
            ) : (
              <button className="send-button" type="submit" disabled={!ready || !input.trim()} aria-label="Send">
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </form>
        <p className="composer-caption">Threads stay in this browser on this Mac. Always review important changes and commands.</p>
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
