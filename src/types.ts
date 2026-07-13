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

export type CatalogPublisher = "andreaborio" | "unsloth";

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
}

export interface CatalogResponse {
  author: "andreaborio";
  label: "DSBox Models";
  sources: CatalogSource[];
  models: CatalogModel[];
  recommended: CatalogModel | null;
  refreshedAt: string;
  stale: boolean;
}

export interface LocalModelCandidate {
  path: string;
  name: string;
  sizeBytes: number;
  modelId: string;
  selected: boolean;
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

export interface AppSnapshot {
  config: DsboxConfig;
  runtime: RuntimeState;
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
  | { type: "config"; payload: DsboxConfig };

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
}

export interface ChatSource {
  title: string;
  url: string;
  snippet: string;
}

export interface ChatResponseStats {
  startedAt: number;
  firstTokenAt: number | null;
  reasoningStartedAt: number | null;
  answerStartedAt: number | null;
  completedAt: number | null;
  promptTokens: number | null;
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
