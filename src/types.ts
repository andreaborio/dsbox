export type ViewId = "chat" | "runtime" | "agents" | "monitor" | "settings";

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
  version: 1;
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

export interface CatalogModel {
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
}

export interface CatalogResponse {
  author: "andreaborio";
  label: "Modelli DSBox";
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
  reasoning?: string;
  pending?: boolean;
  error?: boolean;
  interrupted?: boolean;
}
