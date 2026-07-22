import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CirclePower,
  CircleStop,
  Code2,
  Cpu,
  Database,
  ExternalLink,
  Globe2,
  HardDrive,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Timer,
  Trash2,
  Wrench,
  Zap
} from "lucide-react";
import { Children, isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { AppSnapshot, ChatMessage, ChatSource, ChatToolActivity, LocalModelCandidate, LocalModelSwitchResult, ViewId } from "../types";
import type { DsboxController } from "../hooks/useDsbox";
import { useChatSession } from "../hooks/useChatSession";
import { Button, CopyButton, Modal } from "../components/ui";
import { ModelIdentityIcon } from "../components/ModelIdentityIcon";
import { apiRequest } from "../lib/api";
import { formatBytes, formatModelName } from "../lib/format";
import { identifyModel } from "../lib/model-identity";
import { localModelIsRunnable, normalizeLocalModelCandidates } from "../lib/local-models";
import type { ReasoningEffort } from "../lib/chat-session";

interface Props {
  snapshot: AppSnapshot;
  controller: DsboxController;
  onNavigate: (view: ViewId) => void;
}

interface WebSearchControlOptions {
  modelSupportsTools: boolean;
  agentAvailable: boolean;
  agentActive: boolean;
  tools: readonly string[];
  preference: boolean;
  streaming: boolean;
}

export interface WebSearchControlState {
  visible: boolean;
  requestEnabled: boolean;
  pressed: boolean;
  disabled: boolean;
  label: "Web on" | "Web off";
  ariaLabel: string;
  title: string;
}

export function resolveWebSearchControl(options: WebSearchControlOptions): WebSearchControlState {
  const available = options.modelSupportsTools;
  const pressed = available && options.preference;
  const state = pressed ? "on" : "off";
  const action = pressed ? "off" : "on";
  return {
    visible: true,
    requestEnabled: pressed,
    pressed,
    disabled: !available || options.streaming,
    label: pressed ? "Web on" : "Web off",
    ariaLabel: `Turn web search ${action}`,
    title: !available
      ? "Web search is currently available only when Qwen tools are supported."
      : pressed
      ? `Web search is ${state}. Hebrus Studio may use the network when a prompt needs current information.`
      : `Web search is ${state}. Click to turn it ${action}.`
  };
}

const suggestions = [
  { icon: Code2, title: "Explore a codebase", prompt: "Help me understand a codebase and identify the most important areas to read first." },
  { icon: Database, title: "Design a system", prompt: "Design a robust architecture, explain the trade-offs, and provide a concrete implementation plan." },
  { icon: Cpu, title: "Optimize a hot path", prompt: "Analyze this workload's bottlenecks and propose measurable experiments." }
];

const reasoningEffortOptions: Array<{ value: ReasoningEffort; label: string; description: string; title: string }> = [
  { value: "off", label: "Off", description: "Fastest replies for simple prompts.", title: "Skip model thinking for the next response" },
  { value: "low", label: "Low", description: "Quick thinking for everyday questions.", title: "Faster thinking for simple prompts" },
  { value: "medium", label: "Medium", description: "Balanced thinking for most work.", title: "Balanced thinking for everyday work" },
  { value: "high", label: "High", description: "Deeper reasoning for hard tasks.", title: "Deeper thinking for difficult work" }
];

function reasoningEffortLabel(effort: ReasoningEffort | undefined): string {
  if (effort === "off") return "Off";
  if (effort === "low") return "Low";
  if (effort === "high") return "High";
  return "Medium";
}

type MessageStageState = "prefill" | "thinking" | "decode" | "error" | "off" | "ready" | "preparing" | "tool";

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function messageToolActivities(message: ChatMessage): ChatToolActivity[] {
  return message.blocks?.flatMap((block) => block.type === "tool_call" ? [block.activity] : []) ?? [];
}

function toolLabel(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isWebActivity(activity: ChatToolActivity): boolean {
  return activity.name === "web_search";
}

function activityArguments(activity: ChatToolActivity): Record<string, unknown> | null {
  if (activity.arguments && typeof activity.arguments === "object" && !Array.isArray(activity.arguments)) {
    return activity.arguments as Record<string, unknown>;
  }
  if (!activity.argumentsText.trim()) return null;
  try {
    const parsed = JSON.parse(activity.argumentsText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function compactActivityText(value: string, maximum = 88): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}

export function webActivityQuery(activity: ChatToolActivity): string | null {
  if (!isWebActivity(activity)) return null;
  const payload = activityArguments(activity);
  const candidate = payload?.query ?? payload?.q ?? payload?.search_query ?? payload?.searchQuery;
  if (typeof candidate === "string" && candidate.trim()) return compactActivityText(candidate);
  if (Array.isArray(candidate)) {
    const queries = candidate.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    return queries.length ? compactActivityText(queries.join(" · ")) : null;
  }
  return null;
}

export function toolStateLabel(activity: ChatToolActivity, sourceCount = 0): string {
  if (isWebActivity(activity)) {
    const query = webActivityQuery(activity);
    if (activity.state === "proposed") return query ? `Preparing “${query}”` : "Preparing web search";
    if (activity.state === "running") return query ? `Searching for “${query}”` : "Searching the web";
    if (activity.state === "succeeded") return sourceCount > 0 ? `${sourceCount} ${sourceCount === 1 ? "source" : "sources"} ready` : "Search complete";
    if (activity.state === "canceled") return "Search canceled";
    return activity.error ? compactActivityText(activity.error) : "Web search failed";
  }
  if (activity.summary) return compactActivityText(activity.summary);
  if (activity.state === "proposed") return "Preparing local tool";
  if (activity.state === "running") return "Running on this Mac";
  if (activity.state === "succeeded") return "Completed on this Mac";
  if (activity.state === "canceled") return "Canceled";
  return activity.error ? compactActivityText(activity.error) : "Failed";
}

function displayToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ScopeBadge({ scope }: { scope: "local" | "network" }) {
  return (
    <span className={`scope-badge scope-badge--${scope}`}>
      {scope === "network" ? <Globe2 size={10} /> : <HardDrive size={10} />}
      {scope === "network" ? "Network" : "Local"}
    </span>
  );
}

function ToolActivityItem({ activity, sourceCount, compact = false }: { activity: ChatToolActivity; sourceCount: number; compact?: boolean }) {
  const isWeb = isWebActivity(activity);
  const query = webActivityQuery(activity);
  const shouldAutoOpen = activity.state === "failed" || (!compact && (activity.state === "proposed" || activity.state === "running"));
  const [open, setOpen] = useState(shouldAutoOpen);

  useEffect(() => {
    setOpen(shouldAutoOpen);
  }, [shouldAutoOpen]);

  return (
    <details
      className={`tool-call tool-call--${activity.state} ${isWeb ? "tool-call--network" : "tool-call--local"} ${compact ? "tool-call--compact" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-call__state" aria-hidden="true">
          {activity.state === "running" || activity.state === "proposed"
            ? <LoaderCircle className="spin" size={13} />
            : activity.state === "succeeded"
              ? <Check size={13} />
              : <CircleStop size={12} />}
        </span>
        <span className="tool-call__copy">
          <strong>{isWeb ? "Web search" : toolLabel(activity.name)}</strong>
          <small>{toolStateLabel(activity, sourceCount)}</small>
        </span>
        {activity.durationMs !== undefined && <time>{formatDuration(activity.durationMs)}</time>}
        <ChevronDown className="tool-call__chevron" size={12} />
      </summary>
      <div className="tool-call__details">
        {isWeb ? (
          <>
            {query && <div><strong>Search query</strong><p className="tool-call__plain">{query}</p></div>}
            {activity.state === "succeeded" && sourceCount > 0 && <p className="tool-call__hint">The sources used for this answer are listed below.</p>}
          </>
        ) : (
          <>
            {activity.argumentsText && (
              <div>
                <strong>Input</strong>
                <pre>{activity.argumentsText}</pre>
              </div>
            )}
            {activity.result !== undefined && (
              <div>
                <strong>Result</strong>
                <pre>{displayToolValue(activity.result)}</pre>
              </div>
            )}
          </>
        )}
        {activity.error && <p role="alert">{activity.error}</p>}
      </div>
    </details>
  );
}

function WebActivitySummary({ activities, sourceCount, compact = false }: { activities: ChatToolActivity[]; sourceCount: number; compact?: boolean }) {
  const state: ChatToolActivity["state"] = activities.some((activity) => activity.state === "failed")
    ? "failed"
    : activities.some((activity) => activity.state === "running")
      ? "running"
      : activities.some((activity) => activity.state === "proposed")
        ? "proposed"
        : activities.every((activity) => activity.state === "canceled")
          ? "canceled"
          : "succeeded";
  const queries = [...new Set(activities.flatMap((activity) => webActivityQuery(activity) ?? []))];
  const durationMs = activities.reduce((total, activity) => total + (activity.durationMs ?? 0), 0);
  const shouldAutoOpen = state === "failed" || (!compact && (state === "proposed" || state === "running"));
  const [open, setOpen] = useState(shouldAutoOpen);

  useEffect(() => {
    setOpen(shouldAutoOpen);
  }, [shouldAutoOpen]);

  const status = state === "proposed"
    ? "Preparing web research"
    : state === "running"
      ? queries.length > 1 ? `Searching ${queries.length} queries` : queries[0] ? `Searching for “${queries[0]}”` : "Searching the web"
      : state === "succeeded"
        ? `${activities.length} ${activities.length === 1 ? "search" : "searches"}${sourceCount > 0 ? ` · ${sourceCount} ${sourceCount === 1 ? "source" : "sources"} ready` : " complete"}`
        : state === "canceled"
          ? "Web research canceled"
          : "Web research needs attention";

  return (
    <details
      className={`tool-call tool-call--${state} tool-call--network ${compact ? "tool-call--compact" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-call__state" aria-hidden="true">
          {state === "running" || state === "proposed"
            ? <LoaderCircle className="spin" size={13} />
            : state === "succeeded"
              ? <Check size={13} />
              : <CircleStop size={12} />}
        </span>
        <span className="tool-call__copy">
          <strong>Web research</strong>
          <small>{status}</small>
        </span>
        {durationMs > 0 && <time>{formatDuration(durationMs)}</time>}
        <ChevronDown className="tool-call__chevron" size={12} />
      </summary>
      <div className="tool-call__details">
        {queries.length > 0 && (
          <div>
            <strong>{queries.length === 1 ? "Search query" : "Search queries"}</strong>
            <ol className="tool-call__queries">{queries.map((query) => <li key={query}>{query}</li>)}</ol>
          </div>
        )}
        {state === "succeeded" && sourceCount > 0 && <p className="tool-call__hint">The sources used for this answer are listed below.</p>}
        {activities.flatMap((activity) => activity.error ? [activity.error] : []).map((error, index) => <p role="alert" key={`${error}-${index}`}>{error}</p>)}
      </div>
    </details>
  );
}

function ToolActivityRail({ activities, sourceCount = 0 }: { activities: ChatToolActivity[]; sourceCount?: number }) {
  if (!activities.length) return null;
  const networkActivities = activities.filter(isWebActivity);
  const localActivities = activities.filter((activity) => !isWebActivity(activity));
  const groups = [
    { scope: "network" as const, label: "Web", activities: networkActivities },
    { scope: "local" as const, label: "On this Mac", activities: localActivities }
  ].filter((group) => group.activities.length > 0);

  return (
    <section className="tool-activity" aria-label="Tool activity">
      <div className="tool-activity__head">
        <Wrench size={12} />
        <strong>{networkActivities.length ? (localActivities.length ? "Tools used" : "Web research") : "Local tools"}</strong>
        <span>{activities.length}</span>
      </div>
      <div className="tool-activity__groups">
        {groups.map((group) => (
          <section className={`tool-activity__group tool-activity__group--${group.scope}`} key={group.scope} aria-label={`${group.label} activity`}>
            <div className="tool-activity__group-head">
              <strong>{group.label}</strong>
              <ScopeBadge scope={group.scope} />
            </div>
            <div className="tool-activity__list">
              {group.scope === "network"
                ? <WebActivitySummary activities={group.activities} sourceCount={sourceCount} />
                : group.activities.map((activity) => <ToolActivityItem activity={activity} sourceCount={sourceCount} key={activity.callId} />)}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

export type ReasoningTraceItem =
  | { type: "reasoning"; text: string }
  | { type: "tools"; activities: ChatToolActivity[]; step?: number };

/**
 * Keep the model's emitted work in causal order. Agent runs can alternate
 * reasoning and tool calls more than once, so aggregating each kind into a
 * separate rail makes the trace misleading.
 */
export function reasoningTraceItems(message: ChatMessage): ReasoningTraceItem[] {
  const items: ReasoningTraceItem[] = [];
  let hasReasoningBlock = false;

  for (const block of message.blocks ?? []) {
    if (block.type === "text") continue;
    if (block.type === "reasoning") {
      if (!block.text.trim()) continue;
      hasReasoningBlock = true;
      items.push({ type: "reasoning", text: block.text });
      continue;
    }

    const previous = items.at(-1);
    if (previous?.type === "tools" && block.activity.step !== undefined && previous.step === block.activity.step) {
      previous.activities.push(block.activity);
    } else {
      items.push({ type: "tools", activities: [block.activity], step: block.activity.step });
    }
  }

  // Older persisted conversations may have the aggregate reasoning field but
  // no reasoning block. Its precise position is unknowable, so retain the
  // legacy pre-tool placement instead of hiding it.
  if (!hasReasoningBlock && message.reasoning?.trim()) {
    items.unshift({ type: "reasoning", text: message.reasoning });
  }
  return items;
}

function reasoningTraceDuration(message: ChatMessage, now: number): number | null {
  const stats = message.stats;
  if (!stats) return null;
  if (stats.thinkingMs !== null) return stats.thinkingMs;
  const startedAt = stats.reasoningStartedAt ?? stats.firstTokenAt ?? stats.startedAt;
  if (stats.answerStartedAt !== null) return Math.max(0, stats.answerStartedAt - startedAt);
  if (message.pending) return Math.max(0, now - startedAt);
  return null;
}

export function defaultReasoningExpanded(
  message: Pick<ChatMessage, "content" | "pending" | "error" | "blocks">
): boolean {
  const hasActiveTool = message.blocks?.some((block) => (
    block.type === "tool_call" && (block.activity.state === "proposed" || block.activity.state === "running")
  ));
  return Boolean(message.error || (message.pending && (hasActiveTool || !message.content.trim())));
}

const localThinkingPhrases = [
  "Making Sam Altman a tiny bit poorer",
  "Keeping these tokens off the cloud bill",
  "Letting Metal do the expensive part",
  "Burning local watts, not API credits",
  "Asking this Mac to think in private",
  "Turning unified memory into opinions",
  "Spending zero dollars per token",
  "Giving the GPU a tiny existential task",
  "Keeping inference close to home",
  "No meter running, just local silicon",
  "Heating the room with useful math",
  "Teaching the cache some patience",
  "Making Cupertino silicon earn it",
  "Compressing cloud anxiety locally",
  "Saving the invoice for never"
];

export function localThinkingPhrase(seed: string, now: number): string {
  const bucket = Math.floor(now / 2_400);
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return localThinkingPhrases[(hash + bucket) % localThinkingPhrases.length];
}

function ReasoningTrace({
  message,
  now,
  open,
  sourceCount,
  onToggle,
  onPinOpen
}: {
  message: ChatMessage;
  now: number;
  open: boolean;
  sourceCount: number;
  onToggle: () => void;
  onPinOpen: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const followsTimelineEndRef = useRef(true);
  const items = reasoningTraceItems(message);
  const duration = reasoningTraceDuration(message, now);
  const traceId = `reasoning-trace-${message.id}`;
  const triggerId = `${traceId}-trigger`;
  const activeTool = items
    .flatMap((item) => item.type === "tools" ? item.activities : [])
    .find((activity) => activity.state === "proposed" || activity.state === "running");
  const hasAnswer = Boolean(message.content.trim());
  const traceLive = Boolean(message.pending && (activeTool || !hasAnswer));
  const status = message.error
    ? "Needs attention"
    : message.interrupted
      ? "Stopped"
      : message.pending
        ? activeTool
          ? isWebActivity(activeTool) ? "Searching the web" : `Using ${toolLabel(activeTool.name)}`
          : hasAnswer ? "Reasoning complete" : "Thinking live"
        : "Complete";
  const visibleStatus = traceLive && !open ? localThinkingPhrase(message.id, now) : status;
  const reasoningComponents = useMemo(
    () => messageMarkdownComponents(emptyMessageSources, traceId, traceLive),
    [traceId, traceLive]
  );
  useEffect(() => {
    if (!open || !message.pending || !followsTimelineEndRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (!timeline || !followsTimelineEndRef.current) return;
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [message.blocks, message.pending, message.reasoning, open]);

  return (
    <section className={`reasoning-trace ${open ? "reasoning-trace--open" : ""} ${traceLive ? "reasoning-trace--live" : ""} ${message.error ? "reasoning-trace--error" : message.interrupted ? "reasoning-trace--interrupted" : ""}`} aria-label="Thinking trace">
      <button
        id={triggerId}
        type="button"
        className="reasoning-trace__trigger"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={traceId}
        aria-label={`${open ? "Collapse" : "Expand"} thinking trace. ${visibleStatus}. ${items.length} ${items.length === 1 ? "step" : "steps"}.`}
      >
        <span className="reasoning-trace__heading">
          <strong>Thinking</strong>
          <small>{visibleStatus}</small>
        </span>
        <span className="reasoning-trace__meta">
          {message.reasoningEffort && <span>{reasoningEffortLabel(message.reasoningEffort)}</span>}
          <span>{items.length} {items.length === 1 ? "step" : "steps"}</span>
          {duration !== null && <time>{formatDuration(duration)}</time>}
        </span>
        <ChevronDown className="reasoning-trace__chevron" size={14} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={traceId}
            className="reasoning-trace__body"
            role="region"
            aria-labelledby={triggerId}
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduceMotion ? { opacity: 1, height: "auto" } : { opacity: 0, height: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            <div
              className="reasoning-trace__timeline"
              ref={timelineRef}
              tabIndex={0}
              aria-label="Thinking and tool activity timeline"
              onFocusCapture={onPinOpen}
              onPointerDown={onPinOpen}
              onWheel={onPinOpen}
              onScroll={(event) => {
                const timeline = event.currentTarget;
                followsTimelineEndRef.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 48;
              }}
            >
              {items.map((item, index) => {
                if (item.type === "reasoning") {
                  return (
                    <div className="reasoning-trace__step reasoning-trace__step--thought" key={`reasoning-${index}`}>
                      <div className="reasoning-trace__step-content reasoning-trace__markdown markdown-body">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
                          components={reasoningComponents}
                        >
                          {item.text}
                        </ReactMarkdown>
                      </div>
                    </div>
                  );
                }

                const hasWeb = item.activities.some(isWebActivity);
                const hasLocal = item.activities.some((activity) => !isWebActivity(activity));
                const allWeb = hasWeb && !hasLocal;
                const scopeLabel = hasWeb && hasLocal ? "Mixed network and local" : allWeb ? "Network" : "Local";
                const groupState = item.activities.some((activity) => activity.state === "failed")
                  ? "failed"
                  : item.activities.some((activity) => activity.state === "running" || activity.state === "proposed")
                    ? "active"
                    : "complete";
                return (
                  <section className={`reasoning-trace__step reasoning-trace__step--tool reasoning-trace__step--${groupState}`} aria-label={`${scopeLabel} tool step ${item.step ?? index + 1}`} key={`tools-${item.step ?? index}-${item.activities.map((activity) => activity.callId).join("-")}`}>
                    <div className="reasoning-trace__step-content">
                      <div className="reasoning-trace__step-label">
                        <strong>{allWeb ? "Web research" : item.activities.length === 1 ? toolLabel(item.activities[0].name) : "Tool calls"}</strong>
                        {hasWeb && <ScopeBadge scope="network" />}
                        {hasLocal && <ScopeBadge scope="local" />}
                      </div>
                      <div className="reasoning-trace__tools">
                        {allWeb
                          ? <WebActivitySummary activities={item.activities} sourceCount={sourceCount} compact />
                          : item.activities.map((activity) => <ToolActivityItem activity={activity} sourceCount={sourceCount} compact key={activity.callId} />)}
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${rate.toFixed(rate < 10 ? 2 : 1)} t/s`;
}

function estimateContextTokens(messages: ChatMessage[], input: string): number {
  const contentLength = messages.reduce((total, message) => {
    const blockText = message.blocks?.reduce((sum, block) => {
      if (block.type === "text" || block.type === "reasoning") return sum + block.text.length;
      return sum + block.activity.name.length + block.activity.argumentsText.length + (block.activity.summary?.length ?? 0);
    }, 0) ?? 0;
    return total + message.content.length + (message.reasoning?.length ?? 0) + blockText + 12;
  }, input.length);
  return Math.max(0, Math.ceil(contentLength / 4));
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  return String(tokens);
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

export function sourceFaviconUrl(url: string): string | null {
  const safe = safeSourceUrl(url);
  if (!safe) return null;
  return `${new URL(safe).origin}/favicon.ico`;
}

export function sourcePreviewImageUrl(url: string): string | null {
  const safe = safeSourceUrl(url);
  if (!safe) return null;
  const parameters = new URLSearchParams({
    url: safe,
    screenshot: "true",
    embed: "screenshot.url"
  });
  return `https://api.microlink.io/?${parameters.toString()}`;
}

function sourceAnchorId(messageId: string, sourceNumber: number): string {
  return `source-${messageId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${sourceNumber}`;
}

const revealMessageSourceEvent = "dsbox:reveal-message-source";
const sourceInlineLimit = 3;

export function defaultSourcesExpanded(_sourceCount: number): boolean {
  return false;
}

export function visibleSourceCount(sourceCount: number): number {
  return Math.max(0, Math.min(sourceCount, sourceInlineLimit));
}

export function hiddenSourceCount(sourceCount: number): number {
  return Math.max(0, sourceCount - sourceInlineLimit);
}

export function sourceIndexForCitation(sources: ChatSource[], label: string): number {
  const citationLabel = label.trim().toUpperCase();
  if (/^S[1-9]\d*$/.test(citationLabel)) {
    return sources.findIndex((source) => source.citationId?.toUpperCase() === citationLabel);
  }
  if (!/^[1-9]\d*$/.test(citationLabel)) return -1;
  const positionalNumber = Number(citationLabel);
  return sources.some((source) => source.citationId)
    ? sources.findIndex((source) => source.citationId?.toUpperCase() === `S${positionalNumber}`)
    : positionalNumber - 1;
}

function enhanceTextChildren(
  children: ReactNode,
  sources: ChatSource[],
  messageId: string,
  animateText = false
): ReactNode {
  return Children.map(children, (child, childIndex) => {
    if (typeof child !== "string") return child;
    return child.split(/(\[(?:S)?\d+\])/gi).flatMap((part, partIndex) => {
      const citation = part.match(/^\[((?:S)?\d+)\]$/i);
      if (citation) {
        const citationLabel = citation[1].toUpperCase();
        const sourceIndex = sourceIndexForCitation(sources, citationLabel);
        const source = sourceIndex >= 0 ? sources[sourceIndex] : undefined;
        if (source && safeSourceUrl(source.url)) {
          return <a
            className="citation-chip"
            href={`#${sourceAnchorId(messageId, sourceIndex + 1)}`}
            aria-label={`Source ${citationLabel}: ${source.title}`}
            title={`Jump to source ${citationLabel}: ${source.title}`}
            key={`${childIndex}-citation-${partIndex}-${citationLabel}`}
            onClick={(event) => {
              event.preventDefault();
              window.dispatchEvent(new CustomEvent(revealMessageSourceEvent, {
                detail: { messageId, sourceNumber: sourceIndex + 1 }
              }));
            }}
          >{citationLabel}</a>;
        }
      }
      return animateText ? streamingTextPieces(part, `${messageId}-${childIndex}-${partIndex}`) : part;
    });
  });
}

function SourceFavicon({ url, label }: { url: string; label: string }) {
  const faviconUrl = sourceFaviconUrl(url);
  const fallback = sourceHost(url).replace(/^[^a-z0-9]+/i, "").charAt(0).toUpperCase() || "S";

  return (
    <span className="source-favicon" aria-hidden="true" title={label}>
      <span>{fallback}</span>
      {faviconUrl && (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      )}
    </span>
  );
}

function SourcePreviewCard({
  source,
  href,
  messageId,
  sourceNumber
}: {
  source: ChatSource;
  href: string;
  messageId: string;
  sourceNumber: number;
}) {
  const host = sourceHost(href);
  const title = source.title.trim() || host;
  const snippet = source.snippet.trim();
  const sourceLabel = source.citationId ?? sourceNumber;
  const previewImageUrl = sourcePreviewImageUrl(href);
  const [previewRequested, setPreviewRequested] = useState(false);

  return (
    <a
      id={sourceAnchorId(messageId, sourceNumber)}
      className="source-preview-card"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={snippet || title}
      aria-label={`Open source ${sourceLabel}: ${title}`}
      onPointerEnter={() => setPreviewRequested(true)}
      onFocus={() => setPreviewRequested(true)}
    >
      <span className="source-preview-card__identity">
        <SourceFavicon url={href} label={host} />
        <i>{sourceLabel}</i>
      </span>
      <span className="source-preview-card__copy">
        <strong>{title}</strong>
        {snippet && <span className="source-preview-card__snippet">{snippet}</span>}
        <small>{host}</small>
      </span>
      <ExternalLink className="source-preview-card__open" size={13} aria-hidden="true" />
      <span className="source-preview-card__preview" aria-hidden="true">
        <span className="source-preview-card__preview-shell">
          <span className="source-preview-card__preview-visual">
            <span className="source-preview-card__preview-fallback">
              <SourceFavicon url={href} label={host} />
              <small>Site preview</small>
            </span>
            {previewRequested && previewImageUrl && (
              <img
                src={previewImageUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            )}
          </span>
          <span className="source-preview-card__preview-head">
            <SourceFavicon url={href} label={host} />
            <span>
              <strong>{host}</strong>
              <small>{href}</small>
            </span>
          </span>
          <span className="source-preview-card__preview-title">{title}</span>
          {snippet && <span className="source-preview-card__preview-snippet">{snippet}</span>}
        </span>
      </span>
    </a>
  );
}

function MessageSources({ sources, messageId }: { sources: ChatSource[]; messageId: string }) {
  const validSources = sources.flatMap((source, index) => {
    const href = safeSourceUrl(source.url);
    return href ? [{ source, href, sourceNumber: index + 1 }] : [];
  });
  const sourceCount = validSources.length;
  const primarySources = validSources.slice(0, visibleSourceCount(sourceCount));
  const extraSources = validSources.slice(visibleSourceCount(sourceCount));
  const extraCount = hiddenSourceCount(sourceCount);
  const [extraOpen, setExtraOpen] = useState(() => defaultSourcesExpanded(sourceCount));
  const manuallyToggled = useRef(false);
  const previousSourceCount = useRef(sourceCount);
  const contentId = `message-sources-${messageId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const previewWarmupKey = validSources.slice(0, extraOpen ? 6 : sourceInlineLimit).map(({ href }) => href).join("\n");

  useEffect(() => {
    if (previousSourceCount.current === sourceCount) return;
    previousSourceCount.current = sourceCount;
    if (!manuallyToggled.current) setExtraOpen(defaultSourcesExpanded(sourceCount));
  }, [sourceCount]);

  useEffect(() => {
    const revealSource = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string; sourceNumber?: number }>).detail;
      if (detail?.messageId !== messageId || !detail.sourceNumber) return;
      manuallyToggled.current = true;
      if (detail.sourceNumber > sourceInlineLimit) setExtraOpen(true);
      const anchorId = sourceAnchorId(messageId, detail.sourceNumber);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const target = document.getElementById(anchorId);
        if (!target) return;
        try {
          window.history.replaceState(window.history.state, "", `#${anchorId}`);
        } catch {
          // Hash decoration is optional; opening and scrolling remain functional.
        }
        target.scrollIntoView({ block: "nearest", behavior: "auto" });
        target.focus({ preventScroll: true });
      }));
    };
    window.addEventListener(revealMessageSourceEvent, revealSource);
    return () => window.removeEventListener(revealMessageSourceEvent, revealSource);
  }, [messageId]);

  useEffect(() => {
    if (!previewWarmupKey) return;
    const previewUrls = previewWarmupKey.split("\n").flatMap((href) => {
      const previewUrl = sourcePreviewImageUrl(href);
      return previewUrl ? [previewUrl] : [];
    });
    if (!previewUrls.length) return;

    const preload = () => {
      for (const previewUrl of previewUrls) {
        const image = new Image();
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.src = previewUrl;
      }
    };

    const requestIdleCallback = window.requestIdleCallback;
    const cancelIdleCallback = window.cancelIdleCallback;
    if (typeof requestIdleCallback === "function" && typeof cancelIdleCallback === "function") {
      const idleId = requestIdleCallback(preload, { timeout: 1_200 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = window.setTimeout(preload, 320);
    return () => window.clearTimeout(timeoutId);
  }, [previewWarmupKey]);

  if (!validSources.length) return null;

  return (
    <section className={`message-sources ${extraOpen ? "message-sources--open" : ""}`} aria-label={`Web sources, ${sourceCount}`}>
      <div className="message-sources__head">
        <span className="message-sources__title"><Globe2 size={13} /><strong>Sources</strong><i>{validSources.length}</i></span>
        <span className="message-sources__actions">
          <ScopeBadge scope="network" />
        </span>
      </div>
      <div className="message-sources__rail" aria-label="Top web sources">
        {primarySources.map(({ source, href, sourceNumber }) => (
          <SourcePreviewCard
            key={`${source.url}-${sourceNumber}`}
            source={source}
            href={href}
            messageId={messageId}
            sourceNumber={sourceNumber}
          />
        ))}
      </div>
      {extraCount > 0 && (
        <div className="message-sources__more-wrap">
          <button
            type="button"
            className="message-sources__more"
            aria-expanded={extraOpen}
            aria-controls={contentId}
            onClick={() => {
              manuallyToggled.current = true;
              setExtraOpen((current) => !current);
            }}
          >
            <span>{extraOpen ? "Hide" : "Show"} {extraCount} more</span>
            <ChevronDown className="message-sources__chevron" size={14} aria-hidden="true" />
          </button>
          <AnimatePresence initial={false}>
            {extraOpen && (
              <motion.div
                className="message-sources__extra"
                id={contentId}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="message-sources__grid">
                  {extraSources.map(({ source, href, sourceNumber }) => (
                    <SourcePreviewCard
                      key={`${source.url}-${sourceNumber}`}
                      source={source}
                      href={href}
                      messageId={messageId}
                      sourceNumber={sourceNumber}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

function nodeText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement<{ children?: ReactNode }>(child)) return "";
    return nodeText(child.props.children);
  }).join("");
}

function streamingTextPieces(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\s+)/).map((part, index) => {
    if (!part) return null;
    if (/^\s+$/.test(part)) return part;
    return <span className="stream-word" key={`${keyPrefix}-${index}-${part}`}>{part}</span>;
  });
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

function messageMarkdownComponents(sources: ChatSource[], messageId: string, animateText = false): Components {
  const enhance = (children: ReactNode) => enhanceTextChildren(children, sources, messageId, animateText);
  return {
    ...markdownComponents,
    p: ({ children, node: _node, ...props }) => <p {...props}>{enhance(children)}</p>,
    li: ({ children, node: _node, ...props }) => <li {...props}>{enhance(children)}</li>,
    h1: ({ children, node: _node, ...props }) => <h1 {...props}>{enhance(children)}</h1>,
    h2: ({ children, node: _node, ...props }) => <h2 {...props}>{enhance(children)}</h2>,
    h3: ({ children, node: _node, ...props }) => <h3 {...props}>{enhance(children)}</h3>,
    blockquote: ({ children, node: _node, ...props }) => <blockquote {...props}>{enhance(children)}</blockquote>,
    td: ({ children, node: _node, ...props }) => <td {...props}>{enhance(children)}</td>,
    th: ({ children, node: _node, ...props }) => <th {...props}>{enhance(children)}</th>
  };
}

const emptyMessageSources: ChatSource[] = [];

const MessageMarkdown = memo(function MessageMarkdown({
  content,
  sources,
  messageId,
  animateText = false
}: {
  content: string;
  sources?: ChatSource[];
  messageId: string;
  animateText?: boolean;
}) {
  const sourceList = sources ?? emptyMessageSources;
  const components = useMemo(
    () => messageMarkdownComponents(sourceList, messageId, animateText),
    [animateText, messageId, sourceList]
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});

function previousUserPrompt(messages: ChatMessage[], beforeIndex: number): string | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.content.trim()) return message.content.trim();
  }
  return null;
}

function AgentErrorCard({
  detail,
  usedNetwork,
  retryPrompt,
  webEnabled,
  busy,
  onRetry,
  onRetryWithoutWeb,
  onOpenServer
}: {
  detail: string;
  usedNetwork: boolean;
  retryPrompt: string | null;
  webEnabled: boolean;
  busy: boolean;
  onRetry: () => void;
  onRetryWithoutWeb: () => void;
  onOpenServer: () => void;
}) {
  return (
    <section className="agent-error-card" role="alert">
      <div className="agent-error-card__head">
        <span><CircleAlert size={15} /></span>
        <div>
          <strong>Hebrus Studio couldn’t finish</strong>
          <p>{usedNetwork ? "The web search or model stopped before a complete answer." : "The model stopped before a complete answer."} Your conversation is still here.</p>
        </div>
      </div>
      <div className="agent-error-card__actions">
        {retryPrompt && <button type="button" onClick={onRetry} disabled={busy}><RotateCcw size={13} />Try again</button>}
        {retryPrompt && usedNetwork && webEnabled && <button type="button" onClick={onRetryWithoutWeb} disabled={busy}><ShieldCheck size={13} />Retry without Web</button>}
        <button type="button" onClick={onOpenServer}>Check server</button>
      </div>
      {detail.trim() && (
        <details>
          <summary>Technical details <ChevronDown size={12} /></summary>
          <pre>{detail}</pre>
        </details>
      )}
    </section>
  );
}

export function ChatView({ snapshot, controller, onNavigate }: Props) {
  const chat = useChatSession();
  const { messages, input, reasoningEffort, streaming, capabilities, agentMode, webSearchEnabled } = chat;
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [localModels, setLocalModels] = useState<LocalModelCandidate[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [runMenuPanel, setRunMenuPanel] = useState<"root" | "models" | "reasoning" | "tools">("root");
  const [switchingPath, setSwitchingPath] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const runMenuRef = useRef<HTMLDivElement | null>(null);
  const runTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasStreamingRef = useRef(streaming);
  const capabilityRetryRef = useRef(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    capabilityRetryRef.current = 0;
    void chat.refreshCapabilities();
  }, [snapshot.config.model.id, snapshot.config.model.path, snapshot.runtime.phase, snapshot.runtime.pid, snapshot.runtime.readiness]);

  useEffect(() => {
    if (snapshot.runtime.readiness !== "ready") {
      capabilityRetryRef.current = 0;
      return;
    }
    if (capabilities.status === "ready") {
      capabilityRetryRef.current = 0;
      return;
    }
    if (capabilities.status !== "unknown" && capabilities.status !== "error") return;
    const attempt = capabilityRetryRef.current;
    const delay = Math.min(30_000, 6_000 * (2 ** attempt));
    const timer = window.setTimeout(() => {
      capabilityRetryRef.current = Math.min(attempt + 1, 3);
      void chat.refreshCapabilities();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [capabilities.status, capabilities.reason, snapshot.runtime.readiness]);

  const loadLocalModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const response = await apiRequest<{ models?: unknown }>("/api/models/local");
      setLocalModels(normalizeLocalModelCandidates(response.models).filter(localModelIsRunnable));
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
    if (!runMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (runMenuRef.current?.contains(event.target as Node)) return;
      setRunMenuOpen(false);
      setRunMenuPanel("root");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (runMenuPanel !== "root") {
        setRunMenuPanel("root");
        return;
      }
      setRunMenuOpen(false);
      window.requestAnimationFrame(() => runTriggerRef.current?.focus());
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [runMenuOpen, runMenuPanel]);

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
  }, [chat.activeThreadId, latestAssistantContent?.content, latestAssistantContent?.reasoning, latestAssistantContent?.blocks, latestAssistantContent?.pending, latestAssistantContent?.sources?.length]);

  const ready = snapshot.runtime.readiness === "ready";
  const selectedLocalModel = localModels.find((model) => model.selected || model.path === snapshot.config.model.path);
  const selectedModelIdentity = identifyModel(snapshot.config.model.id, snapshot.config.model.path, selectedLocalModel?.modelId, selectedLocalModel?.name);
  const qwenToolModel = selectedModelIdentity === "qwen";
  const agentAvailable = qwenToolModel && capabilities.status === "ready" && capabilities.chatTools;
  const agentActive = agentAvailable && agentMode;
  const webSearchControl = resolveWebSearchControl({
    modelSupportsTools: qwenToolModel,
    agentAvailable,
    agentActive,
    tools: capabilities.tools,
    preference: webSearchEnabled,
    streaming
  });
  const activeToolSettings = Number(agentActive) + Number(webSearchControl.pressed);
  const toolsSummaryLabel = !qwenToolModel
    ? "Qwen only"
    : capabilities.status === "loading"
      ? "Checking"
      : activeToolSettings > 0
        ? `${activeToolSettings} on`
        : "Off";
  const agentCapabilityMessage = !ready || !qwenToolModel
    ? null
    : capabilities.status === "error" || capabilities.status === "unknown"
    ? "Tool capability could not be verified. Hebrus Studio will use standard chat."
    : capabilities.status === "ready" && !capabilities.chatTools
      ? "This model does not expose tool calling yet. Hebrus Studio will use standard chat."
      : null;
  const preparing = ["preparing", "installing", "updating", "building", "downloading", "starting"].includes(snapshot.runtime.phase);
  const stopping = snapshot.runtime.phase === "stopping";
  const runtimeError = snapshot.runtime.phase === "error";
  const empty = messages.length === 0;
  const currentModelLabel = formatModelName(selectedLocalModel?.modelId || snapshot.config.model.id);
  const contextLimitTokens = Math.max(1, snapshot.config.server.contextTokens);
  const contextUsedTokens = estimateContextTokens(messages, input);
  const contextRatio = Math.min(1, contextUsedTokens / contextLimitTokens);
  const contextPercent = Math.round(contextRatio * 100);
  const contextRingStyle = { "--context-progress": `${Math.round(contextRatio * 360)}deg` } as CSSProperties;
  const contextTitle = `About ${formatCompactTokens(contextUsedTokens)} of ${formatCompactTokens(contextLimitTokens)} context tokens used`;
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
        description: webSearchEnabled
          ? "The model runs on your Mac. Web search is on; only search queries may leave this Mac."
          : "The model, prompts, cache, and code stay on your Mac.",
        notice: "Hebrus Server is ready",
        detail: "you can start typing",
        placeholder: "Message Hebrus Studio…"
      }
    : runtimeError
      ? {
          description: "Hebrus Server needs your attention. Open Server to see what happened and try again.",
          notice: "Hebrus Server needs attention",
          detail: "open Server to resolve it",
          placeholder: "Check the server status…"
        }
      : stopping
        ? {
            description: "Hebrus Server is safely closing the local session.",
            notice: "Turning off Hebrus Server",
            detail: "this will only take a moment",
            placeholder: "Hebrus Server is shutting down…"
          }
        : preparing
          ? {
              description: "Preparing the model on your Mac. Your prompts, cache, and code will stay local.",
              notice: "Starting Hebrus Server",
              detail: "follow the progress in Server",
              placeholder: "Hebrus Server is getting ready…"
            }
          : {
              description: "Start the local server when you are ready. The model, prompts, cache, and code stay on this Mac.",
              notice: "Hebrus Server is off",
              detail: snapshot.runtime.modelPresent ? "paused" : "choose a model first",
              placeholder: "Start Hebrus Server to chat…"
            };
  const canStartServerFromComposer = !ready && !preparing && !stopping && snapshot.runtime.modelPresent && !controller.busyAction;
  const serverStatusActionLabel = snapshot.runtime.modelPresent
    ? canStartServerFromComposer ? "Start" : "Open Server"
    : "Choose model";
  const handleServerStatusAction = () => {
    if (canStartServerFromComposer) {
      void controller.action("Starting Hebrus Server", "/api/runtime/power").catch(() => undefined);
      return;
    }
    onNavigate(snapshot.runtime.modelPresent ? "runtime" : "models");
  };

  const sortedThreads = useMemo(() => [...chat.threads].sort((left, right) => right.updatedAt - left.updatedAt), [chat.threads]);
  const activeThread = chat.threads.find((thread) => thread.id === chat.activeThreadId) ?? chat.threads[0];

  const switchInstalledModel = async (model: LocalModelCandidate) => {
    if (modelSwitchBlocked || model.selected || model.path === snapshot.config.model.path) {
      setRunMenuOpen(false);
      setRunMenuPanel("root");
      return;
    }
    setSwitchingPath(model.path);
    setModelError(null);
    setRunMenuOpen(false);
    setRunMenuPanel("root");
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
      setRunMenuPanel("models");
      setRunMenuOpen(true);
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
    const request = chat.send({ content, model: snapshot.config.model.id, maxTokens: snapshot.config.server.maxOutputTokens });
    if (textAreaRef.current) textAreaRef.current.style.height = "auto";
    return request;
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
    const activeTool = messageToolActivities(message).find((activity) => activity.state === "running" || activity.state === "proposed");
    if (activeTool) return isWebActivity(activeTool)
      ? { state: "tool", label: "Web · Searching" }
      : { state: "tool", label: `Local tool · ${toolLabel(activeTool.name)}` };
    if (message.content) return { state: "decode", label: "Decode · Writing" };
    if (message.reasoning) return { state: "thinking", label: "Thinking · Reasoning" };
    return { state: "prefill", label: "Prefill · Reading context" };
  };

  const stageElapsed = (message: ChatMessage): number | null => {
    if (!message.pending || !message.stats) return null;
    const activeTool = messageToolActivities(message).find((activity) => activity.state === "running" || activity.state === "proposed");
    if (activeTool) return now - (activeTool.startedAt ?? activeTool.createdAt);
    if (message.content) return now - (message.stats.answerStartedAt ?? message.stats.firstTokenAt ?? message.stats.startedAt);
    if (message.reasoning) return now - (message.stats.reasoningStartedAt ?? message.stats.firstTokenAt ?? message.stats.startedAt);
    return now - message.stats.startedAt;
  };

  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const liveStatus = latestAssistant
    ? latestAssistant.pending
      ? `Hebrus Studio: ${messageStage(latestAssistant).label}`
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
              {messages.map((message, messageIndex) => {
                const toolActivities = messageToolActivities(message);
                const hasReasoningTrace = Boolean(
                  message.reasoning?.trim()
                  || message.blocks?.some((block) => block.type === "reasoning" && Boolean(block.text.trim()))
                );
                const validSourceCount = message.sources?.filter((source) => Boolean(safeSourceUrl(source.url))).length ?? 0;
                const retryPrompt = message.error ? previousUserPrompt(messages, messageIndex) : null;
                return <motion.article
                  key={message.id}
                  className={`message message--${message.role} ${message.role === "assistant" && hasReasoningTrace ? "message--has-reasoning" : ""} ${message.error ? "message--error" : ""}`}
                  aria-label={message.role === "user" ? "You" : "Hebrus Studio"}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="message__body">
                    {message.role === "assistant" && message.pending && !hasReasoningTrace && (
                      <div className={`message-stage message-stage--${messageStage(message).state}`}>
                        <span />
                        <strong>{messageStage(message).label}</strong>
                        {stageElapsed(message) !== null && <time>{formatDuration(stageElapsed(message))}</time>}
                      </div>
                    )}
                    {hasReasoningTrace && (
                      <ReasoningTrace
                        message={message}
                        now={now}
                        open={reasoningOpen[message.id] ?? defaultReasoningExpanded(message)}
                        sourceCount={validSourceCount}
                        onToggle={() => setReasoningOpen((current) => ({
                          ...current,
                          [message.id]: !(current[message.id] ?? defaultReasoningExpanded(message))
                        }))}
                        onPinOpen={() => setReasoningOpen((current) => (
                          current[message.id] === true ? current : { ...current, [message.id]: true }
                        ))}
                      />
                    )}
                    {message.skillNotice && <div className="message-skill-notice"><Globe2 size={12} /><span>{message.skillNotice}</span></div>}
                    {message.role === "assistant" && !hasReasoningTrace && <ToolActivityRail activities={toolActivities} sourceCount={validSourceCount} />}
                    {message.error ? (
                      <AgentErrorCard
                        detail={message.content}
                        usedNetwork={validSourceCount > 0 || toolActivities.some(isWebActivity) || Boolean(message.skillNotice?.toLowerCase().includes("web"))}
                        retryPrompt={retryPrompt}
                        webEnabled={webSearchControl.visible && webSearchEnabled}
                        busy={streaming || modelSwitching}
                        onRetry={() => { if (retryPrompt) void send(undefined, retryPrompt); }}
                        onRetryWithoutWeb={() => {
                          if (!retryPrompt) return;
                          chat.setWebSearchEnabled(false);
                          const retry = send(undefined, retryPrompt);
                          if (retry) void retry.finally(() => chat.setWebSearchEnabled(true));
                        }}
                        onOpenServer={() => onNavigate("runtime")}
                      />
                    ) : message.content ? (
                      <div className={`markdown-body ${message.pending && message.role === "assistant" && !message.error ? "markdown-body--streaming" : ""}`}>
                        <MessageMarkdown
                          content={message.content}
                          sources={message.sources}
                          messageId={message.id}
                          animateText={message.pending && message.role === "assistant" && !message.error}
                        />
                      </div>
                    ) : message.interrupted ? (
                      <div className="generation-stopped-copy">Generation stopped before output began.</div>
                    ) : message.pending && !toolActivities.length ? (
                      <div className="typing"><i /><i /><i /></div>
                    ) : null}
                    {message.pending && message.content && !message.error && <span className="stream-caret" />}
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
                          {message.stats.totalMs !== null && <span><Timer size={11} /><strong>{formatDuration(message.stats.totalMs)}</strong><small>total</small></span>}
                          {message.stats.averageTokensPerSecond === null && message.stats.totalMs === null && <span><Timer size={11} /><strong>Details</strong></span>}
                          <ChevronDown className="response-stats__chevron" size={12} />
                        </summary>
                        <dl className="response-stats__details">
                          {message.stats.promptTokens !== null && <div><dt>Prompt</dt><dd>{message.stats.promptTokens.toLocaleString("en-US")} tokens</dd></div>}
                          {message.stats.cachedPromptTokens !== null && <div><dt>Cached prompt</dt><dd>{message.stats.cachedPromptTokens.toLocaleString("en-US")} tokens</dd></div>}
                          {message.stats.completionTokens !== null && <div><dt>Generated</dt><dd>{message.stats.completionTokens.toLocaleString("en-US")} tokens</dd></div>}
                          {message.stats.prefillMs !== null && <div><dt>Prefill latency</dt><dd>{formatDuration(message.stats.prefillMs)}</dd></div>}
                          {message.reasoningEffort && <div><dt>Reasoning effort</dt><dd>{reasoningEffortLabel(message.reasoningEffort)}</dd></div>}
                          {message.stats.thinkingMs !== null && <div><dt>{toolActivities.length ? "Thinking + tools" : "Thinking"}</dt><dd>{formatDuration(message.stats.thinkingMs)}{message.stats.reasoningTokens !== null ? ` · ${message.stats.reasoningTokens.toLocaleString("en-US")} tokens` : ""}</dd></div>}
                          {message.stats.decodeMs !== null && <div><dt>Generation</dt><dd>{formatDuration(message.stats.decodeMs)}</dd></div>}
                          {message.stats.webSearchMs !== null && <div><dt>Web search</dt><dd>{formatDuration(message.stats.webSearchMs)}</dd></div>}
                          <div><dt>Timing</dt><dd>{message.stats.timingSource === "server" ? "Reported by Hebrus" : "Measured end to end"}</dd></div>
                        </dl>
                      </details>
                    )}
                    {message.role === "assistant" && message.sources?.length ? <MessageSources sources={message.sources} messageId={message.id} /> : null}
                  </div>
                </motion.article>;
              })}
            </div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {showJump && !empty && (
          <motion.button
            className="chat-jump"
            onClick={() => scrollToLatest(true)}
            initial={reduceMotion ? false : { opacity: 0, y: 4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 3, scale: 0.98 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
          >
            <ChevronDown size={15} /> Jump to latest
          </motion.button>
        )}
      </AnimatePresence>

      <div className="composer-wrap">
        {!ready && (
          <div className={`server-status ${runtimeError ? "server-status--error" : preparing ? "server-status--starting" : ""}`} role="status" aria-live="polite">
            <span className="server-status__icon" aria-hidden="true"><CirclePower size={13} /></span>
            <span className="server-status__copy">
              <strong>{runtimePresentation.notice}</strong>
              <small>{runtimePresentation.detail}</small>
            </span>
            <button
              type="button"
              className="server-status__action"
              onClick={handleServerStatusAction}
              disabled={Boolean(controller.busyAction) || stopping || preparing}
              aria-label={serverStatusActionLabel === "Start" ? "Start Hebrus Server" : serverStatusActionLabel}
            >
              {serverStatusActionLabel === "Start" ? <CirclePower size={13} /> : <ChevronRight size={13} />}
              <span>{serverStatusActionLabel}</span>
            </button>
          </div>
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
            placeholder={ready ? "Message Hebrus Studio…" : runtimePresentation.placeholder}
            aria-label="Message"
            rows={1}
            disabled={!ready || streaming || modelSwitching}
          />
          {agentCapabilityMessage && (
            <div className="composer__capability" role="status">
              <Wrench size={11} />
              <span>{agentCapabilityMessage}</span>
            </div>
          )}
          <div className="composer__footer">
            <div className="composer__run-group">
              <div className="run-settings" ref={runMenuRef}>
                <button
                  ref={runTriggerRef}
                  type="button"
                  className="run-settings__trigger"
                  onClick={() => {
                    const opening = !runMenuOpen;
                    setRunMenuPanel("root");
                    setRunMenuOpen(opening);
                    if (opening) void loadLocalModels();
                  }}
                  disabled={streaming && modelSwitching}
                  aria-expanded={runMenuOpen}
                  aria-controls="run-settings-popover"
                  aria-haspopup="dialog"
                  aria-label={`Run settings. Model ${currentModelLabel}. Reasoning effort ${reasoningEffortLabel(reasoningEffort)}. Context ${contextPercent}% used.`}
                  title={contextTitle}
                >
                  {modelSwitching ? <LoaderCircle className="spin" size={13} /> : <Zap size={13} />}
                  <span className="run-settings__model">{modelSwitching ? "Switching…" : currentModelLabel}</span>
                  <span className="run-settings__effort">{reasoningEffortLabel(reasoningEffort)}</span>
                  <span className="context-ring" style={contextRingStyle} aria-hidden="true"><span /></span>
                  <ChevronDown size={12} />
                </button>
                <AnimatePresence>
                  {runMenuOpen && (
                    <motion.div
                      id="run-settings-popover"
                      className={`run-settings__menu run-settings__menu--${runMenuPanel}`}
                      role="dialog"
                      aria-label="Run settings"
                      initial={reduceMotion ? false : { opacity: 0, y: 5, scale: 0.985 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 3, scale: 0.99 }}
                      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <AnimatePresence initial={false} mode="wait">
                      {runMenuPanel === "root" && (
                        <motion.div
                          key="root"
                          className="run-settings__root run-settings__panel"
                          initial={reduceMotion ? false : { opacity: 0, x: -4 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={reduceMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: -5 }}
                          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <button type="button" className="run-settings__row" onClick={() => { setRunMenuPanel("models"); void loadLocalModels(); }}>
                            <span>Model</span>
                            <strong>{currentModelLabel}</strong>
                            <ChevronRight size={15} />
                          </button>
                          <button type="button" className="run-settings__row" onClick={() => setRunMenuPanel("reasoning")}>
                            <span>Effort</span>
                            <strong>{reasoningEffortLabel(reasoningEffort)}</strong>
                            <ChevronRight size={15} />
                          </button>
                          <button type="button" className="run-settings__row" onClick={() => setRunMenuPanel("tools")}>
                            <span>Tools</span>
                            <strong>{toolsSummaryLabel}</strong>
                            <ChevronRight size={15} />
                          </button>
                          <div className="run-settings__context">
                            <span className="context-ring context-ring--large" style={contextRingStyle} aria-hidden="true"><span /></span>
                            <div><strong>Context</strong><small>{formatCompactTokens(contextUsedTokens)} / {formatCompactTokens(contextLimitTokens)} tokens · approx.</small></div>
                            <b>{contextPercent}%</b>
                          </div>
                        </motion.div>
                      )}
                      {runMenuPanel === "models" && (
                        <motion.div
                          key="models"
                          className="run-settings__panel"
                          initial={reduceMotion ? false : { opacity: 0, x: 6 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={reduceMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: 5 }}
                          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <div className="run-settings__panel-head">
                            <button type="button" onClick={() => setRunMenuPanel("root")} aria-label="Back to run settings"><ChevronLeft size={15} /></button>
                            <strong>Model</strong>
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
                              const identity = identifyModel(model.modelId, model.name, model.path);
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
                                  <span className={`model-picker__item-icon model-picker__item-icon--${identity}`}><ModelIdentityIcon identity={identity} fallback={<HardDrive size={14} />} /></span>
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
                            <span>Switching restarts Hebrus Server when it is on.</span>
                            <button type="button" onClick={() => { setRunMenuOpen(false); setRunMenuPanel("root"); onNavigate("models"); }}>Manage models</button>
                          </div>
                        </motion.div>
                      )}
                      {runMenuPanel === "reasoning" && (
                        <motion.div
                          key="reasoning"
                          className="run-settings__panel"
                          initial={reduceMotion ? false : { opacity: 0, x: 6 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={reduceMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: 5 }}
                          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <div className="run-settings__panel-head">
                            <button type="button" onClick={() => setRunMenuPanel("root")} aria-label="Back to run settings"><ChevronLeft size={15} /></button>
                            <strong>Effort</strong>
                            <span />
                          </div>
                          <div className="reasoning-menu__list" role="radiogroup" aria-label="Reasoning effort options">
                            {reasoningEffortOptions.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={reasoningEffort === option.value}
                                className={`reasoning-menu__item ${reasoningEffort === option.value ? "reasoning-menu__item--active" : ""}`}
                                onClick={() => {
                                  chat.setReasoningEffort(option.value);
                                  setRunMenuOpen(false);
                                  setRunMenuPanel("root");
                                  window.requestAnimationFrame(() => runTriggerRef.current?.focus());
                                }}
                                title={option.title}
                              >
                                <span className="reasoning-menu__copy">
                                  <strong>{option.label}</strong>
                                  <small>{option.description}</small>
                                </span>
                                {reasoningEffort === option.value && <Check size={14} />}
                              </button>
                            ))}
                          </div>
                        </motion.div>
                      )}
                      {runMenuPanel === "tools" && (
                        <motion.div
                          key="tools"
                          className="run-settings__panel"
                          initial={reduceMotion ? false : { opacity: 0, x: 6 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={reduceMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: 5 }}
                          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <div className="run-settings__panel-head">
                            <button type="button" onClick={() => setRunMenuPanel("root")} aria-label="Back to run settings"><ChevronLeft size={15} /></button>
                            <strong>Tools</strong>
                            <span />
                          </div>
                          <div className="tools-menu__list tools-menu__list--embedded">
                            <div className={`tools-menu__row ${!agentAvailable ? "tools-menu__row--disabled" : ""}`}>
                              <span className="tools-menu__icon"><Wrench size={14} /></span>
                              <span className="tools-menu__copy">
                                <span><strong>Agent mode</strong><ScopeBadge scope="local" /></span>
                                <small>{qwenToolModel
                                  ? agentAvailable
                                    ? `Enabled by default for Qwen · ${capabilities.maxSteps ?? 8} steps max.`
                                    : capabilities.status === "loading"
                                      ? "Checking Qwen tool support."
                                      : capabilities.reason ?? "Qwen tools are not available yet."
                                  : "Tool calling is currently available only with Qwen."}</small>
                              </span>
                              <button
                                type="button"
                                className={`tools-menu__toggle ${agentActive ? "tools-menu__toggle--on" : ""}`}
                                role="switch"
                                aria-checked={agentActive}
                                aria-label="Agent mode"
                                onClick={() => chat.setAgentMode(!agentMode)}
                                disabled={!agentAvailable || streaming}
                              ><span><i /></span></button>
                            </div>
                            <div className={`tools-menu__row ${webSearchControl.disabled ? "tools-menu__row--disabled" : ""}`}>
                              <span className="tools-menu__icon tools-menu__icon--network"><Globe2 size={14} /></span>
                              <span className="tools-menu__copy">
                                <span><strong>Web search</strong><ScopeBadge scope="network" /></span>
                                <small>{qwenToolModel ? "Enabled by default for Qwen. Search queries may leave this Mac." : "Network tools are locked until a Qwen model is selected."}</small>
                              </span>
                              <button
                                type="button"
                                className={`tools-menu__toggle ${webSearchControl.pressed ? "tools-menu__toggle--on" : ""}`}
                                role="switch"
                                aria-checked={webSearchControl.pressed}
                                aria-label={webSearchControl.ariaLabel}
                                title={webSearchControl.title}
                                onClick={() => chat.setWebSearchEnabled(!webSearchEnabled)}
                                disabled={webSearchControl.disabled}
                              ><span><i /></span></button>
                            </div>
                          </div>
                          <div className="tools-menu__privacy"><ShieldCheck size={12} /><span>{qwenToolModel ? "Prompts and files stay local unless Web search sends a query." : "Select Qwen to enable tool calling and network gates."}</span></div>
                        </motion.div>
                      )}
                      </AnimatePresence>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
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
