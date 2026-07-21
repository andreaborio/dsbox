export type ViewId = "chat" | "models" | "runtime" | "agents" | "monitor" | "settings";

export type EnginePhase =
  | "uninstalled"
  | "idle"
  | "preparing"
  | "installing"
  | "updating"
  | "building"
  | "downloading"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface DsboxConfig {
  version: 2;
  repository: {
    url: string;
    branch: string;
    directory: string;
  };
  model: {
    path: string;
    id: string;
  };
  server: {
    internalHost: string;
    internalPort: number;
    contextTokens: number;
    maxOutputTokens: number;
    powerPercent: number;
    threads: number;
    prefillChunk: number | null;
    quality: boolean;
    warmWeights: boolean;
  };
  streaming: {
    enabled: boolean;
    cacheMode: "auto" | "manual";
    cacheSizeGb: number;
    coldStart: boolean;
    preloadExperts: number | null;
  };
  kvCache: {
    enabled: boolean;
    directory: string;
    spaceMb: number;
    minTokens: number;
    continuedIntervalTokens: number;
  };
  observability: {
    traceEnabled: boolean;
    tracePath: string;
    imatrixEnabled: boolean;
    imatrixPath: string;
    imatrixEvery: number;
  };
  gateway: {
    requireApiKey: boolean;
    apiKey: string;
  };
  advanced: {
    extraArgs: string;
    environment: string;
  };
}

export interface RuntimeState {
  phase: EnginePhase;
  installed: boolean;
  built: boolean;
  modelPresent: boolean;
  modelSizeBytes: number;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  command: string[];
  currentTask: string | null;
  gitHead: string | null;
  gitBranch: string | null;
  readiness: "offline" | "loading" | "ready";
}

export interface MetricSample {
  timestamp: number;
  systemCpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryFileCacheBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  memoryPressurePercent: number | null;
  memoryPressureLevel: "normal" | "warning" | "critical" | null;
  processCpuPercent: number;
  processRssBytes: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  tokensPerSecond: number | null;
  loadAverage: number;
}

export interface LogEntry {
  id: number;
  timestamp: string;
  level: "info" | "success" | "warn" | "error" | "runtime";
  source: "dsbox" | "ds4" | "git" | "build" | "download";
  message: string;
}

export type InferenceStage = "idle" | "prefill" | "thinking" | "decode";

export interface InferenceActivity {
  stage: InferenceStage;
  source: "chat" | "agent" | null;
  requestId: string | null;
  startedAt: string | null;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryBytes: number;
  appleSilicon: boolean;
  gatewayBaseUrl: string;
  openAiBaseUrl: string;
  anthropicBaseUrl: string;
}

export interface CatalogModelFile {
  name: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface CatalogModelAssembly {
  type: "concatenate";
  outputFile: string;
}

export interface CatalogModelVariant {
  id: string;
  label: string;
  files: CatalogModelFile[];
  outputFile: string;
  totalBytes: number;
  installable: boolean;
  unavailableReason: string | null;
  assembly: CatalogModelAssembly | null;
}

export type CatalogPublisher = string;

/**
 * GGUF extensions whose routed tensors are stored in DS4's expert-major
 * layout. They remain GGUF containers, but generic GGUF loaders cannot execute
 * them because the canonical routed tensor descriptors are intentionally
 * absent.
 */
export type Ds4ArtifactFormat = "ds4-expert-major-v2";

export interface CatalogSource {
  id: CatalogPublisher;
  label: string;
  url: string;
}

export interface CatalogModel {
  publisher: CatalogPublisher;
  repository: string;
  revision: string;
  label: string;
  description: string;
  modelId: string;
  runtimeBranch: string | null;
  runtimeCommit: string | null;
  files: CatalogModelFile[];
  outputFile: string | null;
  totalBytes: number;
  recommended: boolean;
  experimental: boolean;
  installable: boolean;
  minimumMemoryGb: number | null;
  lastModified: string | null;
  sourceUrl: string;
  unavailableReason: string | null;
  variantCount: number;
  variants: CatalogModelVariant[];
  /** DS4-only physical layout declared by the revision-pinned manifest. */
  artifactFormat?: Ds4ArtifactFormat | null;
  /** Previous repository ids retained so renamed, installed models stay active. */
  previousRepositories?: string[];
  /** Optional catalog metadata. Unknown architectures remain user-selectable. */
  architecture?: "moe" | "dense" | "unknown" | null;
}

export type ModelDownloadStage =
  | "queued"
  | "preflighting"
  | "downloading"
  | "verifying"
  | "ready"
  | "paused"
  | "cancelled"
  | "error";

export type ModelDownloadFileStage = "pending" | "downloading" | "verifying" | "complete" | "error";

export interface ModelDownloadFileSnapshot extends CatalogModelFile {
  downloadedBytes: number;
  stage: ModelDownloadFileStage;
}

export interface ModelDownloadSnapshot {
  id: string;
  repository: string;
  revision: string;
  variantId: string;
  variantLabel: string;
  modelId: string;
  /** Expected physical layout from the catalog contract. Missing only on legacy persisted downloads. */
  artifactFormat?: Ds4ArtifactFormat | null;
  label: string;
  stage: ModelDownloadStage;
  files: ModelDownloadFileSnapshot[];
  outputFile: string;
  totalBytes: number;
  downloadedBytes: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  destinationDirectory: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  disk: {
    availableBytes: number | null;
    requiredBytes: number;
    shortfallBytes: number;
  };
}

export interface CatalogResponse {
  author: "andreaborio";
  label: "Hebrus Studio Models";
  sources: CatalogSource[];
  models: CatalogModel[];
  recommended: CatalogModel | null;
  refreshedAt: string;
  stale: boolean;
}

export type LocalModelCompatibilityCode =
  | "ds4_native"
  | "standard_multipart"
  | "missing_ds4_metadata"
  | "unsupported_architecture"
  | "invalid_gguf"
  | "legacy_unverified";

export interface LocalModelCompatibility {
  status: "compatible" | "unsupported" | "unverified";
  code: LocalModelCompatibilityCode;
  reason: string | null;
}

export interface LocalModelCandidate {
  path: string;
  name: string;
  sizeBytes: number;
  modelId: string;
  selected: boolean;
  compatibility: LocalModelCompatibility;
  architecture: string | null;
  artifactFormat?: Ds4ArtifactFormat | null;
}

export type LocalModelScanStatus = "idle" | "scanning" | "complete" | "cancelled" | "error";
export type LocalModelScanStage = "idle" | "spotlight" | "filesystem" | "validating" | "complete";

export interface LocalModelScanSnapshot {
  id: string | null;
  status: LocalModelScanStatus;
  stage: LocalModelScanStage;
  strategy: "none" | "spotlight" | "filesystem-fallback";
  startedAt: string | null;
  completedAt: string | null;
  progress: {
    directoriesScanned: number;
    entriesScanned: number;
    candidateFiles: number;
    modelsFound: number;
  };
  models: LocalModelCandidate[];
  truncated: boolean;
  warning: string | null;
  error: string | null;
}

export interface NativeModelSelectionResult {
  cancelled: boolean;
  model: LocalModelCandidate | null;
}

export interface LocalModelSwitchResult {
  model: LocalModelCandidate;
  changed: boolean;
  restarted: boolean;
}

export interface AppSnapshot {
  config: DsboxConfig;
  runtime: RuntimeState;
  downloads: ModelDownloadSnapshot[];
  metrics: MetricSample[];
  logs: LogEntry[];
  activity: InferenceActivity;
  system: SystemInfo;
}

export type ServerEvent =
  | { type: "snapshot"; payload: AppSnapshot }
  | { type: "runtime"; payload: RuntimeState }
  | { type: "metrics"; payload: MetricSample }
  | { type: "log"; payload: LogEntry }
  | { type: "activity"; payload: InferenceActivity }
  | { type: "config"; payload: DsboxConfig }
  | { type: "download"; payload: ModelDownloadSnapshot };

export type ChatToolCallState = "proposed" | "running" | "succeeded" | "failed" | "canceled";

export interface ChatToolActivity {
  callId: string;
  name: string;
  step?: number;
  state: ChatToolCallState;
  argumentsText: string;
  arguments?: unknown;
  result?: unknown;
  summary?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export type ChatMessageBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; activity: ChatToolActivity };

export type ChatAgentEventType =
  | "run.created"
  | "text.delta"
  | "reasoning.delta"
  | "tool_call.created"
  | "tool_call.arguments.delta"
  | "tool_call.arguments.done"
  | "tool_call.completed"
  | "tool_call.started"
  | "tool_call.result"
  | "tool_result.started"
  | "tool_result.completed"
  | "tool_call.failed"
  | "response.usage"
  | "response.completed"
  | "run.error"
  | "run.completed";

export interface ChatAgentEvent {
  type: ChatAgentEventType;
  step?: number;
  callId?: string;
  name?: string;
  delta?: string;
  arguments?: unknown;
  result?: unknown;
  summary?: string;
  error?: string;
  durationMs?: number;
  usage?: Record<string, unknown>;
  timings?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  reasoning?: string;
  pending?: boolean;
  error?: boolean;
  interrupted?: boolean;
  stats?: ChatResponseStats;
  sources?: ChatSource[];
  skillNotice?: string;
  blocks?: ChatMessageBlock[];
}

export interface ChatSource {
  title: string;
  url: string;
  snippet: string;
  /** Stable run-scoped identifier emitted by the Agent gateway (for example S3). */
  citationId?: string;
}

export interface ChatResponseStats {
  startedAt: number;
  firstTokenAt: number | null;
  reasoningStartedAt: number | null;
  answerStartedAt: number | null;
  completedAt: number | null;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  prefillMs: number | null;
  thinkingMs: number | null;
  decodeMs: number | null;
  totalMs: number | null;
  webSearchMs: number | null;
  prefillTokensPerSecond: number | null;
  averageTokensPerSecond: number | null;
  timingSource: "server" | "end-to-end";
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
