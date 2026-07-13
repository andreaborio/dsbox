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
  RotateCcw,
  Sparkles
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppSnapshot, ChatMessage, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { Button } from "../components/ui";
import { DsboxOrb, type DsboxOrbState } from "../components/DsboxOrb";
import { formatModelName } from "../lib/format";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

const suggestions = [
  { icon: Code2, title: "Analizza una codebase", prompt: "Aiutami a orientarmi in una codebase e trova i punti più importanti da leggere." },
  { icon: Database, title: "Progetta un sistema", prompt: "Progetta un'architettura robusta, con trade-off e un piano di implementazione concreto." },
  { icon: Cpu, title: "Ottimizza un hot path", prompt: "Ragiona sui colli di bottiglia di questo workload e proponi esperimenti misurabili." }
];

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return typeof message.id === "string"
    && (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string"
    && (message.reasoning === undefined || typeof message.reasoning === "string")
    && (message.pending === undefined || typeof message.pending === "boolean")
    && (message.error === undefined || typeof message.error === "boolean")
    && (message.interrupted === undefined || typeof message.interrupted === "boolean");
}

function readSavedMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem("dsbox:chat");
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isChatMessage).slice(-80) : [];
  } catch {
    return [];
  }
}

export function ChatView({ snapshot, onNavigate }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(readSavedMessages);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    try {
      localStorage.setItem("dsbox:chat", JSON.stringify(messages.filter((message) => !message.pending).slice(-80)));
    } catch {
      try {
        localStorage.removeItem("dsbox:chat");
      } catch {
        // The conversation remains available for this session even when storage is unavailable.
      }
    }
  }, [messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: streaming || reduceMotion ? "auto" : "smooth", block: "end" });
  }, [messages, reduceMotion, streaming]);

  const ready = snapshot.runtime.readiness === "ready";
  const preparing = ["preparing", "installing", "updating", "building", "downloading", "starting"].includes(snapshot.runtime.phase);
  const stopping = snapshot.runtime.phase === "stopping";
  const runtimeError = snapshot.runtime.phase === "error";
  const empty = messages.length === 0;
  const runtimePresentation = ready
    ? {
        orb: "ready" as DsboxOrbState,
        description: "Il modello gira sul tuo Mac. Prompt, cache e codice restano locali.",
        notice: "DSBox è pronto",
        detail: "puoi iniziare a scrivere",
        placeholder: "Scrivi un messaggio…"
      }
    : runtimeError
      ? {
          orb: "error" as DsboxOrbState,
          description: "DSBox richiede attenzione. Apri Server per vedere cosa è successo e riprovare.",
          notice: "DSBox richiede attenzione",
          detail: "apri Server per risolvere",
          placeholder: "Controlla lo stato del server…"
        }
      : stopping
        ? {
            orb: "preparing" as DsboxOrbState,
            description: "DSBox sta chiudendo la sessione locale in modo sicuro.",
            notice: "Sto spegnendo DSBox",
            detail: "attendi qualche istante",
            placeholder: "DSBox si sta spegnendo…"
          }
        : preparing
          ? {
              orb: "preparing" as DsboxOrbState,
              description: "Sto preparando il modello sul tuo Mac. Prompt, cache e codice resteranno locali.",
              notice: "Sto preparando DSBox",
              detail: "puoi seguire l'avanzamento",
              placeholder: "DSBox si sta preparando…"
            }
          : {
              orb: "off" as DsboxOrbState,
              description: "Quando accendi DSBox, modello, prompt, cache e codice restano sul tuo Mac.",
              notice: "DSBox è spento",
              detail: "accendilo per iniziare",
              placeholder: "Accendi DSBox per chattare…"
            };

  const requestMessages = useMemo(() => messages
    .filter((message) => !message.pending && !message.error && !message.interrupted)
    .map(({ role, content }) => ({ role, content })), [messages]);

  const updateAssistant = (id: string, patch: Partial<ChatMessage>) => {
    setMessages((current) => current.map((message) => message.id === id ? { ...message, ...patch } : message));
  };

  const send = async (event?: FormEvent, suggested?: string) => {
    event?.preventDefault();
    const content = (suggested ?? input).trim();
    if (!content || streaming) return;
    if (!ready) {
      onNavigate("runtime");
      return;
    }

    const user: ChatMessage = { id: createId(), role: "user", content };
    const assistant: ChatMessage = { id: createId(), role: "assistant", content: "", reasoning: "", pending: true };
    const outgoing = [...requestMessages, { role: "user" as const, content }];
    setMessages((current) => [...current, user, assistant]);
    setInput("");
    if (textAreaRef.current) textAreaRef.current.style.height = "auto";
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const body: Record<string, unknown> = {
        model: snapshot.config.model.id,
        messages: outgoing,
        max_tokens: Math.min(snapshot.config.server.maxOutputTokens, 32_768),
        stream: true,
        stream_options: { include_usage: true }
      };
      if (!thinking) body.thinking = { type: "disabled" };
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsbox-control": "1" },
        body: JSON.stringify(body),
        signal: abort.signal
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? `Chat non disponibile (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      let fullReasoning = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          const event = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
          };
          const delta = event.choices?.[0]?.delta;
          fullContent += delta?.content ?? "";
          fullReasoning += delta?.reasoning_content ?? delta?.reasoning ?? "";
          updateAssistant(assistant.id, { content: fullContent, reasoning: fullReasoning, pending: true });
        }
      }
      updateAssistant(assistant.id, { content: fullContent || "Risposta completata senza testo visibile.", reasoning: fullReasoning, pending: false });
    } catch (reason) {
      if ((reason as Error).name === "AbortError") {
        setMessages((current) => current.flatMap((message) => {
          if (message.id !== assistant.id) return [message];
          if (!message.content.trim() && !message.reasoning?.trim()) return [];
          return [{ ...message, pending: false, interrupted: true }];
        }));
      } else {
        updateAssistant(assistant.id, {
          content: reason instanceof Error ? reason.message : String(reason),
          pending: false,
          error: true
        });
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const stop = () => abortRef.current?.abort();
  const clear = () => {
    if (streaming) stop();
    setMessages([]);
    try {
      localStorage.removeItem("dsbox:chat");
    } catch {
      // Storage may be unavailable in hardened browser profiles.
    }
  };

  const resizeComposer = () => {
    const element = textAreaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  };

  const messageStage = (message: ChatMessage): { state: DsboxOrbState; label: string } => {
    if (message.error) return { state: "error", label: "Serve attenzione" };
    if (message.interrupted) return { state: "off", label: "Generazione interrotta" };
    if (!message.pending) return { state: "ready", label: "Completato" };
    if (message.content) return { state: "decode", label: "Decode · Scrivo" };
    if (message.reasoning) return { state: "thinking", label: "Thinking · Ragiono" };
    return { state: "prefill", label: "Prefill · Leggo il contesto" };
  };

  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const liveStatus = latestAssistant
    ? latestAssistant.pending
      ? `DSBox: ${messageStage(latestAssistant).label}`
      : latestAssistant.error
        ? "La risposta non è riuscita."
        : latestAssistant.interrupted
          ? "Generazione interrotta."
          : "Risposta completata."
    : "";

  return (
    <div className={`chat-layout ${empty ? "chat-layout--empty" : ""} ${!ready ? "chat-layout--runtime-blocked" : ""}`}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</div>
      {!empty && (
        <div className="chat-toolbar">
          <div className="chat-toolbar__model"><span className="mini-orb" /><span>{formatModelName(snapshot.config.model.id)}</span></div>
          <button className={`thinking-chip ${thinking ? "thinking-chip--on" : ""}`} onClick={() => setThinking((value) => !value)} aria-pressed={thinking}>
            <Brain size={14} />
            {thinking ? "Ragiona" : "Risposta diretta"}
          </button>
          <button className="chat-toolbar__clear" onClick={clear}><RotateCcw size={14} /> Nuova chat</button>
        </div>
      )}

      <div className="chat-scroll">
        <AnimatePresence mode="popLayout">
          {empty ? (
            <motion.div
              className="chat-empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
            >
              <DsboxOrb state={runtimePresentation.orb} size="md" />
              <div className="eyebrow chat-empty__model"><Sparkles size={13} /><span>{formatModelName(snapshot.config.model.id)} · sul tuo Mac</span></div>
              <h2>Cosa vuoi costruire?</h2>
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
            <div className="message-list" role="log" aria-live="off" aria-label="Conversazione">
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
                      <div className={`message-stage message-stage--${messageStage(message).state}`}><span />{messageStage(message).label}</div>
                    )}
                    {message.reasoning && (
                      <div className={`reasoning ${reasoningOpen[message.id] ? "reasoning--open" : ""}`}>
                        <button onClick={() => setReasoningOpen((current) => ({ ...current, [message.id]: !current[message.id] }))} aria-expanded={Boolean(reasoningOpen[message.id])}>
                          <Brain size={14} />
                          <span>Ragionamento</span>
                          {message.pending && <span className="reasoning__live">live</span>}
                          <ChevronDown className="reasoning__chevron" size={13} />
                        </button>
                        {reasoningOpen[message.id] && <p>{message.reasoning}</p>}
                      </div>
                    )}
                    {message.content ? (
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                    ) : message.pending ? (
                      <div className="typing"><i /><i /><i /></div>
                    ) : null}
                    {message.pending && message.content && <span className="stream-caret" />}
                    {message.role === "assistant" && !message.pending && !message.error && (
                      <div className={`message__complete ${message.interrupted ? "message__complete--interrupted" : ""}`}>
                        {message.interrupted ? <CircleStop size={12} /> : <Check size={12} />}
                        {message.interrupted ? "Interrotta" : "Locale"}
                      </div>
                    )}
                  </div>
                </motion.article>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </AnimatePresence>
      </div>

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
            onChange={(event) => { setInput(event.target.value); resizeComposer(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={runtimePresentation.placeholder}
            aria-label="Messaggio"
            rows={1}
            disabled={!ready || streaming}
          />
          <div className="composer__footer">
            <button type="button" className={`thinking-toggle ${thinking ? "thinking-toggle--on" : ""}`} onClick={() => setThinking((value) => !value)} aria-pressed={thinking}>
              <Brain size={15} /> {thinking ? "Ragiona" : "Risposta diretta"}
            </button>
            {streaming ? (
              <Button type="button" variant="primary" className="send-button send-button--stop" icon={<CircleStop size={16} />} onClick={stop}>Stop</Button>
            ) : (
              <button className="send-button" type="submit" disabled={!ready || !input.trim()} aria-label="Invia">
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </form>
        <p className="composer-caption">DSBox può sbagliare. Verifica sempre modifiche e comandi importanti.</p>
      </div>
    </div>
  );
}
