import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { access, lstat, mkdir, readFile, readdir, rename, stat, statfs, writeFile } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import type {
  CatalogModel,
  Ds4ArtifactFormat,
  LocalModelCandidate,
  LocalModelScanSnapshot,
  LocalModelSwitchResult,
  LogEntry,
  NativeModelSelectionResult,
  RuntimeState
} from "../src/types.js";
import { ConfigStore } from "./config.js";
import { EventBus } from "./event-bus.js";
import { chooseGgufFileInFinder } from "./native-file-picker.js";
import { argumentOptionName, shellDisplayArgument, tokenizeArguments } from "../src/lib/arguments.js";
import {
  buildEngineArguments,
  GLM52_ARCHITECTURE,
  QWEN35_ARCHITECTURE,
  QWEN35_MODEL_ID
} from "../src/lib/engine-arguments.js";
import {
  inspectDs4Gguf,
  type Ds4GgufCompatibility
} from "./gguf-compatibility.js";

export { tokenizeArguments } from "../src/lib/arguments.js";
export { buildEngineArguments } from "../src/lib/engine-arguments.js";

const execFileAsync = promisify(execFile);
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;
const ansiPattern = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const automaticMemoryPollMs = 1_000;
const automaticMemoryReadFailureLimit = 3;
const automaticSafetyTermGraceMs = 3_000;
const automaticSafetyKillGraceMs = 5_000;
const fallbackModelVariables: Record<string, string> = {
  "q2-imatrix": "Q2_IMATRIX_FILE",
  "q2-q4-imatrix": "Q2_Q4_IMATRIX_FILE",
  "q4-imatrix": "Q4_IMATRIX_FILE",
  "pro-q2-imatrix": "PRO_Q2_IMATRIX_FILE"
};

const localModelInventoryVersion = 1;
export const EXPERT_MAJOR_RUNTIME_BRANCH = "main";
export const EXPERT_MAJOR_RUNTIME_COMMIT = "fe0919b70571678408f2c8c52aec8d49525e715c";
export const GLM52_RUNTIME_BRANCH = EXPERT_MAJOR_RUNTIME_BRANCH;
export const GLM52_RUNTIME_COMMIT = EXPERT_MAJOR_RUNTIME_COMMIT;

interface LocalModelInventoryRecord {
  path: string;
  modelId: string;
}

interface LocalModelInventoryDocument {
  version: typeof localModelInventoryVersion;
  models: LocalModelInventoryRecord[];
}

interface LocalModelInspection {
  candidate: LocalModelCandidate | null;
  message: string | null;
}

function localCompatibilityMessage(inspection: Ds4GgufCompatibility): string {
  const reason = inspection.reason;
  if (!reason) return "This GGUF is compatible with DS4.";
  if (reason.code === "multipart_unsupported") return reason.message;
  if (reason.code === "unsupported_architecture") return reason.message;
  if (reason.code === "missing_metadata") {
    const firstMissing = reason.missingKeys?.[0];
    return `This GGUF is not compatible with DS4. It is missing the DS4 model metadata required to run${firstMissing ? ` (${firstMissing})` : ""}.`;
  }
  if (["missing_architecture", "invalid_metadata_type", "missing_tensor_signature", "empty_tensor_directory"].includes(reason.code)) {
    return "This GGUF is not compatible with DS4. It uses a different model metadata or tensor layout.";
  }
  if (reason.code === "unsupported_gguf_version") return reason.message;
  return "This file is not a readable GGUF model. Choose a complete .gguf file.";
}

function localCompatibilityCode(
  inspection: Ds4GgufCompatibility
): LocalModelCandidate["compatibility"]["code"] {
  switch (inspection.reason?.code) {
    case "multipart_unsupported":
      return "standard_multipart";
    case "unsupported_architecture":
      return "unsupported_architecture";
    case "empty_tensor_directory":
    case "missing_architecture":
    case "missing_metadata":
    case "invalid_metadata_type":
    case "missing_tensor_signature":
      return "missing_ds4_metadata";
    default:
      return "invalid_gguf";
  }
}

export function parseFallbackModelFilename(script: string, variant: string): string | null {
  const variable = fallbackModelVariables[variant];
  if (!variable) return null;
  const match = script.match(new RegExp(`^${variable}=(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`, "m"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function remainingDownloadBytes(estimatedBytes: number, partialBytes: number): number {
  return Math.max(0, estimatedBytes - Math.max(0, partialBytes));
}

export function parseVmStatSwapoutPages(output: string): number | null {
  const match = output.match(/^Swapouts:\s+(\d+)\.?\s*$/im);
  if (!match) return null;
  const pages = Number(match[1]);
  return Number.isSafeInteger(pages) && pages >= 0 ? pages : null;
}

export function ds4BuildInfoMatchesHead(output: string, head: string): boolean {
  const match = output.match(/^git:\s+([a-f0-9]{7,64})\s*$/im);
  if (!match || !/^[a-f0-9]{40,64}$/i.test(head)) return false;
  const buildHead = match[1].toLowerCase();
  return head.toLowerCase().startsWith(buildHead);
}

export function orderedLocalModelScanRoots(
  selectedModelPath: string,
  dsboxHomeDirectory: string,
  userHome: string
): string[] {
  return [...new Set([
    path.dirname(selectedModelPath),
    path.join(dsboxHomeDirectory, "models"),
    path.join(userHome, "Downloads"),
    path.join(userHome, "Documents"),
    path.join(userHome, "Desktop"),
    path.join(userHome, "Models"),
    userHome,
    path.join(userHome, ".cache", "huggingface", "hub"),
    "/Volumes",
    "/Users/Shared",
    "/opt",
    "/usr/local",
    "/private/var/tmp",
    "/"
  ].map((root) => path.resolve(root)))];
}

export class TaskCancelledError extends Error {
  constructor() {
    super("Operation cancelled by the user");
    this.name = "TaskCancelledError";
  }
}

export function isTaskCancelledError(error: unknown): error is TaskCancelledError {
  return error instanceof Error && error.name === "TaskCancelledError";
}

export class ModelSelectionError extends Error {
  readonly status: 400 | 409 | 500;

  constructor(message: string, status: 400 | 409 | 500 = 400) {
    super(message);
    this.name = "ModelSelectionError";
    this.status = status;
  }
}

export class ModelSwitchError extends ModelSelectionError {
  readonly rolledBack: boolean;
  readonly runtimeRestored: boolean;

  constructor(message: string, rolledBack: boolean, runtimeRestored: boolean) {
    super(message, 500);
    this.name = "ModelSwitchError";
    this.rolledBack = rolledBack;
    this.runtimeRestored = runtimeRestored;
  }
}

const initialLocalModelScan: LocalModelScanSnapshot = {
  id: null,
  status: "idle",
  stage: "idle",
  strategy: "none",
  startedAt: null,
  completedAt: null,
  progress: {
    directoriesScanned: 0,
    entriesScanned: 0,
    candidateFiles: 0,
    modelsFound: 0
  },
  models: [],
  truncated: false,
  warning: null,
  error: null
};

function scanAbortError(): Error {
  const error = new Error("Model scan cancelled");
  error.name = "AbortError";
  return error;
}

const initialState: RuntimeState = {
  phase: "uninstalled",
  installed: false,
  built: false,
  modelPresent: false,
  modelSizeBytes: 0,
  pid: null,
  startedAt: null,
  lastError: null,
  command: [],
  currentTask: null,
  gitHead: null,
  gitBranch: null,
  readiness: "offline"
};

export function parseEnvironment(input: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid environment variable: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}

function isOptionToken(value: string): boolean {
  return value.startsWith("--") || /^-[A-Za-z]$/.test(value);
}

function optionName(value: string): string {
  return argumentOptionName(value);
}

export class RuntimeManager {
  private readonly store: ConfigStore;
  private readonly bus: EventBus;
  private state: RuntimeState = structuredClone(initialState);
  private logs: LogEntry[] = [];
  private nextLogId = 1;
  private engine: ManagedChild | null = null;
  private task: ManagedChild | null = null;
  private readinessTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private startPending = false;
  private modelSelectionPending = false;
  private modelSwitchPending = false;
  private modelPickerPending = false;
  private localModelScan = structuredClone(initialLocalModelScan);
  private localModelScanController: AbortController | null = null;
  private nextLocalModelScanId = 1;
  private localModelInventoryQueue: Promise<void> = Promise.resolve();
  private readonly cancelledTasks = new WeakSet<ManagedChild>();
  private automaticMemoryGuard: {
    baselineSwapoutPages: number;
    maxSwapoutDeltaPages: number;
    consecutiveReadFailures: number;
    triggered: boolean;
  } | null = null;
  private automaticMemoryTimer: NodeJS.Timeout | null = null;
  private automaticMemoryPollPending = false;
  private automaticSafetyStopPromise: Promise<void> | null = null;

  constructor(store: ConfigStore, bus: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  getState(): RuntimeState {
    return structuredClone(this.state);
  }

  getLogs(): LogEntry[] {
    return structuredClone(this.logs);
  }

  getPid(): number | null {
    return this.engine?.pid ?? null;
  }

  hasTask(): boolean {
    return this.task !== null;
  }

  isSwitchingModel(): boolean {
    return this.modelSwitchPending;
  }

  private async darwinMemorySafetySnapshot(): Promise<{
    pressureLevel: number;
    swapoutPages: number;
  } | null> {
    if (process.platform !== "darwin") return null;
    const [pressure, vmStat] = await Promise.all([
      execFileAsync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 900 }).catch(() => null),
      execFileAsync("vm_stat", [], { timeout: 900 }).catch(() => null)
    ]);
    if (!pressure || !vmStat) return null;
    const pressureLevel = Number(pressure.stdout.trim());
    const swapoutPages = parseVmStatSwapoutPages(vmStat.stdout);
    if (![1, 2, 4].includes(pressureLevel) || swapoutPages === null) return null;
    return { pressureLevel, swapoutPages };
  }

  private clearAutomaticMemoryWatchdog(): void {
    if (this.automaticMemoryTimer) clearInterval(this.automaticMemoryTimer);
    this.automaticMemoryTimer = null;
  }

  private startAutomaticMemoryWatchdog(): void {
    this.clearAutomaticMemoryWatchdog();
    if (!this.automaticMemoryGuard || !this.engine) return;
    this.automaticMemoryTimer = setInterval(
      () => void this.pollAutomaticMemorySafety(),
      automaticMemoryPollMs
    );
    this.automaticMemoryTimer.unref();
  }

  private async pollAutomaticMemorySafety(): Promise<void> {
    if (this.automaticMemoryPollPending || this.stopping) return;
    const guard = this.automaticMemoryGuard;
    const child = this.engine;
    if (!guard || !child) return;
    this.automaticMemoryPollPending = true;
    try {
      const snapshot = await this.darwinMemorySafetySnapshot();
      if (this.automaticMemoryGuard !== guard || this.engine !== child) return;
      await this.enforceAutomaticMemorySafety(
        snapshot?.pressureLevel ?? null,
        snapshot?.swapoutPages ?? null
      );
    } finally {
      this.automaticMemoryPollPending = false;
    }
  }

  private async waitForChildExit(child: ManagedChild, timeoutMs: number): Promise<boolean> {
    if (this.engine !== child) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timeout = setTimeout(() => finish(this.engine !== child), timeoutMs);
      timeout.unref();
      child.once("exit", onExit);
    });
  }

  private async performAutomaticSafetyStop(reason: string): Promise<void> {
    const child = this.engine;
    if (!child) return;
    this.clearAutomaticMemoryWatchdog();
    this.stopping = true;
    this.setState({ phase: "stopping", currentTask: "Emergency memory-pressure shutdown" });
    this.log("warn", "dsbox", "Safety watchdog is sending SIGTERM to protect macOS memory pressure.");
    child.kill("SIGTERM");
    let exited = await this.waitForChildExit(child, automaticSafetyTermGraceMs);

    if (!exited && this.engine === child) {
      this.log("warn", "dsbox", "Safety shutdown grace expired; sending SIGKILL.");
      child.kill("SIGKILL");
      exited = await this.waitForChildExit(child, automaticSafetyKillGraceMs);
    }

    if (!exited && this.engine === child) {
      this.log("error", "dsbox", "The runtime did not exit after SIGKILL; the watchdog will retry.");
      const guard = this.automaticMemoryGuard;
      if (guard) guard.triggered = false;
      this.stopping = false;
      this.setState({ phase: "error", currentTask: null, lastError: reason });
      this.startAutomaticMemoryWatchdog();
      return;
    }

    this.setState({
      phase: "error",
      readiness: "offline",
      pid: null,
      currentTask: null,
      lastError: reason,
      startedAt: null
    });
  }

  private automaticSafetyStop(reason: string): Promise<void> {
    if (this.automaticSafetyStopPromise) return this.automaticSafetyStopPromise;
    this.automaticSafetyStopPromise = (async () => {
      try {
        await this.performAutomaticSafetyStop(reason);
      } finally {
        this.automaticSafetyStopPromise = null;
      }
    })();
    return this.automaticSafetyStopPromise;
  }

  async enforceAutomaticMemorySafety(
    pressureLevel: number | null,
    swapoutPages: number | null
  ): Promise<void> {
    const guard = this.automaticMemoryGuard;
    if (!guard || !this.engine || this.stopping || guard.triggered) return;

    let reason: string | null = null;
    if (pressureLevel === null || swapoutPages === null) {
      guard.consecutiveReadFailures += 1;
      if (guard.consecutiveReadFailures < automaticMemoryReadFailureLimit) return;
      reason = "Automatic cache stopped: macOS memory safety signals were unavailable for three consecutive checks.";
    } else {
      guard.consecutiveReadFailures = 0;
      const swapoutDelta = Math.max(0, swapoutPages - guard.baselineSwapoutPages);
      if (pressureLevel >= 2) {
        reason = "Automatic cache stopped: macOS memory pressure reached WARNING.";
      } else if (swapoutDelta > guard.maxSwapoutDeltaPages) {
        reason = `Automatic cache stopped: host-wide swapout grew by ${swapoutDelta} pages.`;
      }
    }
    if (!reason) return;

    guard.triggered = true;
    this.log("error", "dsbox", reason);
    await this.automaticSafetyStop(reason);
  }

  private modelChangeBlocked(): boolean {
    return Boolean(this.task || this.engine || this.startPending || this.modelSwitchPending || this.state.phase === "preparing");
  }

  prepareOneClickStart(): void {
    if (this.engine || this.task || this.startPending || this.modelSelectionPending || this.modelSwitchPending || this.state.phase === "preparing") throw new Error("DSBox is already working");
    this.setState({
      phase: "preparing",
      readiness: "offline",
      currentTask: "Selecting the model and settings",
      lastError: null
    });
  }

  failOneClickStart(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.state.phase === "error" && this.state.lastError === message) return;
    this.log("error", "dsbox", message);
    if (!this.engine && !this.task) {
      this.setState({ phase: "error", readiness: "offline", currentTask: null, lastError: message });
    }
  }

  private setState(patch: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...patch };
    this.bus.publish({ type: "runtime", payload: this.getState() });
  }

  log(level: LogEntry["level"], source: LogEntry["source"], message: string): void {
    const clean = message.replace(ansiPattern, "").trimEnd();
    if (!clean) return;
    for (const line of clean.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry: LogEntry = {
        id: this.nextLogId++,
        timestamp: new Date().toISOString(),
        level,
        source,
        message: line
      };
      this.logs.push(entry);
      if (this.logs.length > 1200) this.logs.shift();
      this.bus.publish({ type: "log", payload: entry });
    }
  }

  private async pathExists(target: string, executable = false): Promise<boolean> {
    try {
      await access(target, executable ? fsConstants.X_OK : fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async sha256(target: string): Promise<string> {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(target);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.once("error", reject);
      stream.once("end", resolve);
    });
    return hash.digest("hex");
  }

  private async fullGitHead(directory: string): Promise<string | null> {
    return execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory })
      .then((result) => result.stdout.trim() || null)
      .catch(() => null);
  }

  private buildStampPath(directory: string): string {
    const checkoutId = createHash("sha256").update(path.resolve(directory)).digest("hex");
    return path.join(this.store.homeDirectory, "builds", `${checkoutId}.json`);
  }

  private async recordBuildHead(directory: string): Promise<void> {
    const head = await this.fullGitHead(directory);
    if (!head) return;
    const binarySha256 = await this.sha256(path.join(directory, "ds4-server"));
    const clean = await execFileAsync("git", ["status", "--porcelain"], { cwd: directory })
      .then((result) => !result.stdout.trim())
      .catch(() => false);
    const stamp = this.buildStampPath(directory);
    await mkdir(path.dirname(stamp), { recursive: true, mode: 0o700 });
    const partial = `${stamp}.partial-${process.pid}`;
    await writeFile(partial, `${JSON.stringify({ directory: path.resolve(directory), head, clean, binarySha256, builtAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(partial, stamp);
  }

  private async buildMatchesHead(directory: string): Promise<boolean> {
    if (!(await this.pathExists(path.join(directory, "ds4-server"), true))) return false;
    const head = await this.fullGitHead(directory);
    if (!head) return false;
    const checkoutClean = await execFileAsync("git", ["status", "--porcelain"], { cwd: directory })
      .then((result) => !result.stdout.trim())
      .catch(() => false);
    if (!checkoutClean) return false;
    try {
      const stamp = JSON.parse(await readFile(this.buildStampPath(directory), "utf8")) as { directory?: string; head?: string; clean?: boolean; binarySha256?: string };
      if (stamp.directory !== path.resolve(directory) || stamp.head !== head || stamp.clean !== true || !stamp.binarySha256) return false;
      return await this.sha256(path.join(directory, "ds4-server")) === stamp.binarySha256;
    } catch {
      return false;
    }
  }

  private async ensureDiskSpace(target: string, requiredBytes: number): Promise<void> {
    if (requiredBytes <= 0) return;
    const disk = await statfs(target);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const reserveBytes = 4 * 1024 ** 3;
    if (freeBytes < requiredBytes + reserveBytes) {
      const requiredGb = Math.ceil((requiredBytes + reserveBytes) / 1024 ** 3);
      const freeGb = Math.floor(freeBytes / 1024 ** 3);
      throw new Error(`Not enough disk space: about ${requiredGb} GB free required, ${freeGb} GB available`);
    }
  }

  private async ensureAppleMetalToolchain(): Promise<void> {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("This version of DSBox requires macOS on Apple Silicon (arm64)");
    }
    try {
      await execFileAsync("xcrun", ["--find", "clang"], { timeout: 5000 });
    } catch {
      throw new Error("Apple toolchain not found. Install Xcode Command Line Tools with: xcode-select --install");
    }
  }

  private async ensurePortAvailable(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.unref();
      probe.once("error", () => reject(new Error(`Internal port ${host}:${port} is already in use`)));
      probe.listen(port, host, () => probe.close(() => resolve()));
    });
  }

  async refresh(): Promise<RuntimeState> {
    let config = this.store.get();
    const gitDirectory = path.join(config.repository.directory, ".git");
    const binary = path.join(config.repository.directory, "ds4-server");
    const installed = await this.pathExists(gitDirectory);
    const built = installed && await this.pathExists(binary, true);
    let modelPresent = false;
    let modelSizeBytes = 0;
    try {
      const modelStat = await stat(config.model.path);
      if (modelStat.isFile()) {
        const inspection = await this.inspectLocalModelWithReason(config.model.path, config.model.path);
        modelPresent = inspection.candidate?.compatibility.status === "compatible";
        modelSizeBytes = modelPresent ? inspection.candidate?.sizeBytes ?? 0 : 0;
        if (modelPresent && inspection.candidate) {
          const canonicalModelId = this.localModelId(inspection.candidate, config.model.id);
          if (canonicalModelId !== config.model.id) {
            const next = structuredClone(config);
            next.model.id = canonicalModelId;
            config = await this.store.set(next);
            this.bus.publish({ type: "config", payload: config });
          }
        }
      }
    } catch {
      // Model may not have been selected yet.
    }

    let gitHead: string | null = null;
    let gitBranch: string | null = null;
    if (installed) {
      try {
        const [headResult, branchResult] = await Promise.all([
          execFileAsync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: config.repository.directory }),
          execFileAsync("git", ["branch", "--show-current"], { cwd: config.repository.directory })
        ]);
        gitHead = headResult.stdout.trim() || null;
        gitBranch = branchResult.stdout.trim() || null;
      } catch {
        // Git metadata is informative, not required to launch a built runtime.
      }
    }

    const phase = this.engine || this.task
      ? this.state.phase
      : this.state.phase === "preparing"
        ? "preparing"
      : installed
        ? this.state.phase === "error" ? "error" : "idle"
        : "uninstalled";

    this.setState({
      installed,
      built,
      modelPresent,
      modelSizeBytes,
      gitHead,
      gitBranch,
      phase
    });
    return this.getState();
  }

  private streamLines(
    child: ManagedChild,
    source: LogEntry["source"],
    level: LogEntry["level"] = "info"
  ): void {
    const connect = (stream: NodeJS.ReadableStream, streamLevel: LogEntry["level"]) => {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) this.log(streamLevel, source, line);
      });
      stream.on("end", () => {
        if (buffer) this.log(streamLevel, source, buffer);
      });
    };
    connect(child.stdout, level);
    connect(child.stderr, source === "ds4" ? "runtime" : level);
  }

  private async runTask(
    command: string,
    args: string[],
    cwd: string,
    source: LogEntry["source"]
  ): Promise<void> {
    if (this.task || this.engine) throw new Error("Another DS4 operation is already in progress");
    this.log("info", source, `$ ${[command, ...args].map(shellDisplayArgument).join(" ")}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.task = child;
      this.streamLines(child, source);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (this.task === child) this.task = null;
        const cancelled = this.cancelledTasks.has(child);
        if (cancelled) this.cancelledTasks.delete(child);
        if (cancelled) reject(new TaskCancelledError());
        else if (error) reject(error);
        else resolve();
      };
      child.once("error", (error) => {
        finish(error);
      });
      child.once("exit", (code, signal) => {
        if (code === 0) finish();
        else finish(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? "?"}`}`));
      });
    });
  }

  async installOrUpdate(allowModelSwitch = false): Promise<void> {
    if (this.task || this.engine || (this.modelSwitchPending && !allowModelSwitch)) {
      throw new Error("Stop the runtime before updating");
    }
    const config = this.store.get();
    const directory = config.repository.directory;
    const installed = await this.pathExists(path.join(directory, ".git"));
    this.setState({
      phase: installed ? "updating" : "installing",
      currentTask: installed ? "Updating the fork" : "Cloning the fork",
      lastError: null
    });
    try {
      await this.ensureAppleMetalToolchain();
      if (!installed) {
        const parent = path.dirname(directory);
        await mkdir(parent, { recursive: true });
        try {
          const existing = await lstat(directory);
          if (existing) throw new Error(`The folder ${directory} exists but is not a Git checkout`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await this.runTask(
          "git",
          ["clone", "--branch", config.repository.branch, "--single-branch", config.repository.url, directory],
          parent,
          "git"
        );
      } else {
        const statusResult = await execFileAsync("git", ["status", "--porcelain"], { cwd: directory });
        if (statusResult.stdout.trim()) {
          this.log("warn", "git", "The checkout has local changes: sync skipped and no files were overwritten.");
        } else {
          await this.runTask("git", ["fetch", "origin", config.repository.branch], directory, "git");
          const localBranch = await execFileAsync(
            "git",
            ["show-ref", "--verify", "--quiet", `refs/heads/${config.repository.branch}`],
            { cwd: directory }
          ).then(() => true).catch(() => false);
          if (localBranch) {
            await this.runTask("git", ["checkout", config.repository.branch], directory, "git");
            await this.runTask("git", ["merge", "--ff-only", `origin/${config.repository.branch}`], directory, "git");
          } else {
            await this.runTask(
              "git",
              ["checkout", "--track", "-b", config.repository.branch, `origin/${config.repository.branch}`],
              directory,
              "git"
            );
          }
        }
      }

      this.setState({ phase: "building", currentTask: "Build Metal" });
      await this.runTask("make", [`-j${Math.max(2, Math.min(cpus().length, 12))}`, "ds4-server"], directory, "build");
      await this.recordBuildHead(directory);
      this.log("success", "dsbox", "Metal engine ready.");
      this.setState({ phase: "idle", currentTask: null, lastError: null });
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.log("info", "dsbox", "Operation cancelled. No partial files were deleted.");
        this.setState({ phase: "idle", currentTask: null, lastError: null });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", "dsbox", message);
      this.setState({ phase: "error", currentTask: null, lastError: message });
      throw error;
    } finally {
      await this.refresh();
    }
  }

  async build(allowModelSwitch = false): Promise<void> {
    if (this.task || this.engine || (this.modelSwitchPending && !allowModelSwitch)) {
      throw new Error("Stop the runtime before building");
    }
    const config = this.store.get();
    if (!(await this.pathExists(path.join(config.repository.directory, ".git")))) {
      throw new Error("Install or select a ds4 checkout first");
    }
    this.setState({ phase: "building", currentTask: "Build Metal", lastError: null });
    try {
      await this.ensureAppleMetalToolchain();
      await this.runTask("make", [`-j${Math.max(2, Math.min(cpus().length, 12))}`, "ds4-server"], config.repository.directory, "build");
      await this.recordBuildHead(config.repository.directory);
      this.log("success", "dsbox", "Metal build completed.");
      this.setState({ phase: "idle", currentTask: null });
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.log("info", "dsbox", "Operation cancelled.");
        this.setState({ phase: "idle", currentTask: null, lastError: null });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ phase: "error", currentTask: null, lastError: message });
      throw error;
    } finally {
      await this.refresh();
    }
  }

  private async fallbackDownloadedBytes(script: string, variant: string, directory: string, estimatedBytes: number): Promise<number> {
    try {
      const scriptContents = await readFile(script, "utf8");
      const filename = parseFallbackModelFilename(scriptContents, variant);
      if (!filename) return 0;
      const configuredOutput = process.env.DS4_GGUF_DIR || path.join(directory, "gguf");
      const outputDirectory = path.isAbsolute(configuredOutput)
        ? configuredOutput
        : path.resolve(directory, configuredOutput);
      const destination = path.join(outputDirectory, path.basename(filename));
      try {
        const completed = await stat(destination);
        if (completed.isFile() && completed.size > 0) return estimatedBytes;
      } catch {
        // No completed model yet.
      }
      try {
        const partial = await stat(`${destination}.part`);
        return Math.min(estimatedBytes, partial.isFile() ? partial.size : 0);
      } catch {
        return 0;
      }
    } catch {
      return 0;
    }
  }

  async downloadModel(variant: string): Promise<void> {
    const estimatedSizesGb: Record<string, number> = {
      "q2-imatrix": 81,
      "q2-q4-imatrix": 98,
      "q4-imatrix": 153,
      "pro-q2-imatrix": 430
    };
    const allowed = new Set(Object.keys(estimatedSizesGb));
    if (!allowed.has(variant)) throw new Error("This model variant is not supported by the launcher");
    if (this.task || this.engine || this.modelSwitchPending) throw new Error("Stop the runtime before downloading a model");
    const config = this.store.get();
    const script = path.join(config.repository.directory, "download_model.sh");
    if (!(await this.pathExists(script))) throw new Error("download_model.sh was not found: install the fork first");
    const estimatedBytes = estimatedSizesGb[variant] * 1024 ** 3;
    const downloadedBytes = await this.fallbackDownloadedBytes(script, variant, config.repository.directory, estimatedBytes);
    await this.ensureDiskSpace(config.repository.directory, remainingDownloadBytes(estimatedBytes, downloadedBytes));
    if (downloadedBytes > 0 && downloadedBytes < estimatedBytes) {
      this.log("info", "download", `Resuming download: ${Math.floor(downloadedBytes / 1024 ** 3)} GB already available.`);
    }
    this.setState({ phase: "downloading", currentTask: `Download ${variant}`, lastError: null });
    try {
      await this.runTask("/bin/zsh", [script, variant], config.repository.directory, "download");
      this.log("success", "dsbox", "Download completed and the ds4flash.gguf link was updated.");
      this.setState({ phase: "idle", currentTask: null });
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.log("info", "dsbox", "Download cancelled. You can resume it later.");
        this.setState({ phase: "idle", currentTask: null, lastError: null });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ phase: "error", currentTask: null, lastError: message });
      throw error;
    } finally {
      await this.refresh();
    }
  }

  private async runtimeIncludesCommit(directory: string, commit: string): Promise<boolean> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) return false;
    return execFileAsync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: directory })
      .then(() => true)
      .catch(() => false);
  }

  private async ensureCatalogRuntime(model: CatalogModel): Promise<void> {
    if (!model.runtimeCommit) {
      if (model.recommended) throw new Error("The model manifest does not declare a verifiable DS4 engine version");
      return;
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(model.runtimeCommit)) {
      throw new Error("The DS4 commit required by this model is invalid");
    }

    let config = this.store.get();
    const gitDirectory = path.join(config.repository.directory, ".git");
    if (!(await this.pathExists(gitDirectory))) {
      this.log("info", "dsbox", "Preparing the engine required by this model before download.");
      await this.installOrUpdate();
      config = this.store.get();
    }
    const sourceCompatible = await this.runtimeIncludesCommit(config.repository.directory, model.runtimeCommit);
    if (sourceCompatible && await this.buildMatchesHead(config.repository.directory)) return;

    const dirty = await execFileAsync("git", ["status", "--porcelain"], { cwd: config.repository.directory })
      .then((result) => Boolean(result.stdout.trim()))
      .catch(() => true);
    if (dirty) {
      throw new Error("The DS4 checkout has local changes and cannot be verified or rebuilt automatically for this model");
    }

    if (sourceCompatible) {
      this.log("info", "build", "Rebuilding DS4 to match the model's verified commit.");
      await this.build();
      if (!(await this.buildMatchesHead(config.repository.directory))) {
        throw new Error("The DS4 binary does not match the commit verified for this model");
      }
      return;
    }

    this.log("info", "git", `Updating DS4 to the model requirement (${model.runtimeCommit.slice(0, 9)}).`);
    await this.installOrUpdate();
    if (!(await this.runtimeIncludesCommit(config.repository.directory, model.runtimeCommit))) {
      throw new Error(`The ${model.runtimeBranch ?? config.repository.branch} channel does not contain the DS4 commit required by this model`);
    }
    if (!(await this.buildMatchesHead(config.repository.directory))) {
      throw new Error("The updated engine did not produce a binary associated with the current Git commit");
    }
    this.log("success", "git", "DS4 engine updated and rebuilt for the selected model.");
  }

  async prepareCatalogRuntime(model: CatalogModel): Promise<void> {
    if (model.artifactFormat) {
      await this.ensureExpertMajorRuntimeCheckout(
        this.store.get(),
        model.artifactFormat,
        false,
        model.modelId
      );
    }
    await this.ensureCatalogRuntime(model);
  }

  private inferLocalModelId(filePath: string): string {
    const filename = path.basename(filePath, path.extname(filePath));
    if (/qwen[-_. ]?3[._-]?6.*35b.*a3b/i.test(filename) || /qwen36.*35b.*a3b/i.test(filename)) {
      return QWEN35_MODEL_ID;
    }
    if (/glm[-_. ]?5[._-]?2/i.test(filename) || /glm52/i.test(filename)) return "glm-5.2";
    if (/deepseek[-_. ]?v?4/i.test(filename)) return "deepseek-v4-flash";
    return filename.slice(0, 160) || "local-model";
  }

  private localModelId(candidate: LocalModelCandidate, requestedModelId?: string): string {
    return candidate.architecture === QWEN35_ARCHITECTURE
      ? QWEN35_MODEL_ID
      : requestedModelId?.trim() || candidate.modelId;
  }

  private get localModelInventoryPath(): string {
    return path.join(this.store.homeDirectory, "local-models.json");
  }

  private async readLocalModelInventory(): Promise<LocalModelInventoryRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.localModelInventoryPath, "utf8")) as Partial<LocalModelInventoryDocument>;
      if (parsed.version !== localModelInventoryVersion || !Array.isArray(parsed.models)) return [];
      return parsed.models.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = entry as Partial<LocalModelInventoryRecord>;
        if (
          typeof candidate.path !== "string"
          || !path.isAbsolute(candidate.path)
          || !candidate.path.toLowerCase().endsWith(".gguf")
          || typeof candidate.modelId !== "string"
          || !candidate.modelId.trim()
          || candidate.modelId.length > 160
        ) return [];
        return [{ path: path.resolve(candidate.path), modelId: candidate.modelId.trim() }];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  private async writeLocalModelInventory(records: LocalModelInventoryRecord[]): Promise<void> {
    const models = [...records]
      .sort((left, right) => left.path.localeCompare(right.path));
    const document: LocalModelInventoryDocument = { version: localModelInventoryVersion, models };
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    try {
      if (await readFile(this.localModelInventoryPath, "utf8") === serialized) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.store.homeDirectory, { recursive: true });
    const temporaryPath = `${this.localModelInventoryPath}.tmp`;
    await writeFile(temporaryPath, serialized, { mode: 0o600 });
    await rename(temporaryPath, this.localModelInventoryPath);
  }

  private queueLocalModelInventory<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.localModelInventoryQueue.then(operation, operation);
    this.localModelInventoryQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Reconcile known paths under one serialized transaction. Every entry is
   * re-opened before it is written. Deleted or unreadable paths are pruned;
   * GGUF files the current runtime cannot execute remain visible with a fresh
   * compatibility reason so a later DS4 build can make them runnable in place.
   */
  private reconcileLocalModelInventory(incoming: LocalModelCandidate[]): Promise<LocalModelCandidate[]> {
    return this.queueLocalModelInventory(async () => {
      const config = this.store.get();
      const selectedPath = path.resolve(config.model.path);
      const records = await this.readLocalModelInventory();
      const known = new Map<string, LocalModelInventoryRecord>();
      for (const record of records) known.set(path.resolve(record.path), record);
      for (const candidate of incoming) {
        const candidatePath = path.resolve(candidate.path);
        known.set(candidatePath, { path: candidatePath, modelId: candidate.modelId });
      }

      const validated: LocalModelCandidate[] = [];
      for (const record of known.values()) {
        const candidate = await this.inspectLocalModel(record.path, selectedPath);
        if (!candidate) continue;
        validated.push({
          ...candidate,
          modelId: this.localModelId(candidate, candidate.selected ? config.model.id : record.modelId)
        });
      }
      if (!known.has(selectedPath)) {
        const selected = await this.inspectLocalModel(selectedPath, selectedPath);
        if (selected) validated.push({
          ...selected,
          modelId: this.localModelId(selected, config.model.id),
          selected: selected.compatibility.status === "compatible"
        });
      }

      const unique = new Map<string, LocalModelCandidate>();
      for (const candidate of validated) unique.set(candidate.path, candidate);
      const models = [...unique.values()];
      await this.writeLocalModelInventory(models.map((candidate) => ({
        path: candidate.path,
        modelId: candidate.modelId
      })));
      return models;
    });
  }

  private async inspectLocalModelWithReason(filePath: string, selectedPath: string): Promise<LocalModelInspection> {
    const absolutePath = path.resolve(filePath);
    if (!absolutePath.toLowerCase().endsWith(".gguf")) {
      return { candidate: null, message: "Choose a complete .gguf model file." };
    }
    const filename = path.basename(absolutePath);
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        return { candidate: null, message: "The selected path is not a GGUF model file." };
      }
      const unsupportedCandidate = (
        code: LocalModelCandidate["compatibility"]["code"],
        reason: string,
        architecture: string | null = null,
        artifactFormat: LocalModelCandidate["artifactFormat"] = null
      ): LocalModelCandidate => ({
        path: absolutePath,
        name: path.basename(absolutePath, ".gguf"),
        sizeBytes: info.size,
        modelId: this.inferLocalModelId(absolutePath),
        selected: false,
        compatibility: { status: "unsupported", code, reason },
        architecture,
        artifactFormat
      });
      if (/\.(?:head(?:er)?\w*|partial|part)\.gguf$/i.test(filename)) {
        const message = "This looks like a partial GGUF download. Choose the complete model file instead.";
        return { candidate: unsupportedCandidate("invalid_gguf", message), message };
      }
      if (/^.*-\d{5}-of-\d{5}\.gguf$/i.test(filename)) {
        const message = "DS4 does not support standard multi-file GGUF sets. Choose a single DS4-native GGUF instead.";
        return { candidate: unsupportedCandidate("standard_multipart", message), message };
      }
      const compatibility = await inspectDs4Gguf(absolutePath);
      if (!compatibility.compatible) {
        const message = localCompatibilityMessage(compatibility);
        const reason = compatibility.reason?.message ?? message;
        return {
          candidate: unsupportedCandidate(
            localCompatibilityCode(compatibility),
            reason,
            compatibility.architecture,
            compatibility.artifactFormat
          ),
          message
        };
      }
      return {
        candidate: {
          path: absolutePath,
          name: path.basename(absolutePath, ".gguf"),
          sizeBytes: info.size,
          modelId: this.inferLocalModelId(absolutePath),
          selected: absolutePath === path.resolve(selectedPath),
          compatibility: { status: "compatible", code: "ds4_native", reason: null },
          architecture: compatibility.architecture,
          artifactFormat: compatibility.artifactFormat
        },
        message: null
      };
    } catch {
      return { candidate: null, message: "This file does not exist or DSBox cannot read it." };
    }
  }

  private async inspectLocalModel(filePath: string, selectedPath: string): Promise<LocalModelCandidate | null> {
    return (await this.inspectLocalModelWithReason(filePath, selectedPath)).candidate;
  }

  async validateLocalModel(
    filePath: string,
    selectedPath = filePath,
    expectedArtifactFormat?: Ds4ArtifactFormat | null
  ): Promise<LocalModelCandidate> {
    if (!path.isAbsolute(filePath)) throw new ModelSelectionError("DSBox did not receive a valid model location");
    const inspection = await this.inspectLocalModelWithReason(filePath, selectedPath);
    if (!inspection.candidate || inspection.candidate.compatibility.status !== "compatible") {
      throw new ModelSelectionError(inspection.message ?? "This file is not compatible with DS4");
    }
    if (
      expectedArtifactFormat !== undefined
      && (inspection.candidate.artifactFormat ?? null) !== expectedArtifactFormat
    ) {
      const expected = expectedArtifactFormat ?? "canonical GGUF";
      const detected = inspection.candidate.artifactFormat ?? "canonical GGUF";
      throw new ModelSelectionError(
        `The downloaded file uses ${detected}, but the catalog declared ${expected}. Refresh the catalog and download the pinned artifact again.`
      );
    }
    return inspection.candidate;
  }

  async discoverLocalModels(): Promise<LocalModelCandidate[]> {
    const config = this.store.get();
    const candidates: LocalModelCandidate[] = [];
    const selected = await this.inspectLocalModel(config.model.path, config.model.path);
    if (selected) candidates.push({ ...selected, modelId: config.model.id });
    const models = await this.reconcileLocalModelInventory(candidates);
    return models.sort((left, right) => Number(right.selected) - Number(left.selected) || right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name));
  }

  getLocalModelScan(): LocalModelScanSnapshot {
    return structuredClone(this.localModelScan);
  }

  private updateLocalModelScan(
    scanId: string,
    patch: Partial<Omit<LocalModelScanSnapshot, "progress">> & {
      progress?: Partial<LocalModelScanSnapshot["progress"]>;
    }
  ): void {
    if (this.localModelScan.id !== scanId) return;
    this.localModelScan = {
      ...this.localModelScan,
      ...patch,
      progress: {
        ...this.localModelScan.progress,
        ...patch.progress
      }
    };
  }

  private async spotlightGgufPaths(
    signal: AbortSignal,
    onCandidateCount: (count: number) => void
  ): Promise<{ paths: string[]; truncated: boolean } | null> {
    if (process.platform !== "darwin" || process.env.NODE_ENV === "test") return null;
    const limit = 1_000;
    return new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/mdfind",
        ["-0", "-onlyin", "/", "kMDItemFSName == '*.gguf'cd"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const paths: string[] = [];
      let buffer = "";
      let truncated = false;
      let settled = false;
      let timedOut = false;
      let timeout: NodeJS.Timeout | null = null;
      let forceTimeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (forceTimeout) clearTimeout(forceTimeout);
        signal.removeEventListener("abort", abort);
      };
      const finish = (result: { paths: string[]; truncated: boolean } | null, error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => {
        child.kill("SIGKILL");
        finish(null, scanAbortError());
      };
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceTimeout = setTimeout(() => {
          child.kill("SIGKILL");
          finish(null);
        }, 1_000);
        forceTimeout.unref();
      }, 15_000);
      timeout.unref();
      signal.addEventListener("abort", abort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const pieces = buffer.split("\0");
        buffer = pieces.pop() ?? "";
        for (const item of pieces) {
          const candidate = item.trim();
          if (!candidate) continue;
          if (paths.length < limit) paths.push(candidate);
          else truncated = true;
        }
        onCandidateCount(paths.length);
      });
      child.once("error", () => finish(null));
      child.once("exit", (code) => {
        if (signal.aborted) {
          finish(null, scanAbortError());
          return;
        }
        if (buffer.trim()) {
          if (paths.length < limit) paths.push(buffer.trim());
          else truncated = true;
        }
        onCandidateCount(paths.length);
        finish(code === 0 && !timedOut ? { paths, truncated } : null);
      });
    });
  }

  private fullScanRoots(): string[] {
    const config = this.store.get();
    if (process.env.NODE_ENV === "test") return [this.store.homeDirectory];
    const userHome = homedir();
    return orderedLocalModelScanRoots(config.model.path, this.store.homeDirectory, userHome);
  }

  private async filesystemGgufPaths(
    signal: AbortSignal,
    onProgress: (progress: Pick<LocalModelScanSnapshot["progress"], "directoriesScanned" | "entriesScanned" | "candidateFiles">) => void
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const deadline = Date.now() + 30_000;
    const entryLimit = 200_000;
    const candidateLimit = 1_000;
    const depthLimit = 24;
    const skippedDirectories = new Set([
      ".git",
      ".Trash",
      ".Trashes",
      ".Spotlight-V100",
      ".fseventsd",
      "node_modules"
    ]);
    const skippedSystemRootDirectories = new Set([
      ".vol",
      "Applications",
      "Library",
      "Network",
      "System",
      "Users",
      "Volumes",
      "bin",
      "cores",
      "dev",
      "etc",
      "home",
      "private",
      "sbin",
      "tmp",
      "usr",
      "var"
    ]);
    const paths: string[] = [];
    const seenDirectories = new Set<string>();
    let directoriesScanned = 0;
    let entriesScanned = 0;
    let truncated = false;
    let stopped = false;

    const report = () => onProgress({ directoriesScanned, entriesScanned, candidateFiles: paths.length });
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (signal.aborted) throw scanAbortError();
      if (depth > depthLimit) {
        truncated = true;
        return;
      }
      if (entriesScanned >= entryLimit || paths.length >= candidateLimit || Date.now() >= deadline) {
        truncated = true;
        stopped = true;
        return;
      }
      const absoluteDirectory = path.resolve(directory);
      if (seenDirectories.has(absoluteDirectory)) return;
      seenDirectories.add(absoluteDirectory);
      let entries;
      try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch {
        return;
      }
      directoriesScanned += 1;
      for (const entry of entries) {
        if (signal.aborted) throw scanAbortError();
        entriesScanned += 1;
        if (entriesScanned >= entryLimit || paths.length >= candidateLimit || Date.now() >= deadline) {
          truncated = true;
          stopped = true;
          break;
        }
        const candidatePath = path.join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) {
          const skippedAtFilesystemRoot = absoluteDirectory === "/" && skippedSystemRootDirectories.has(entry.name);
          const hiddenDirectory = entry.name.startsWith(".");
          const macLibrary = absoluteDirectory === homedir() && entry.name === "Library";
          if (!skippedAtFilesystemRoot && !hiddenDirectory && !macLibrary && !skippedDirectories.has(entry.name)) {
            await visit(candidatePath, depth + 1);
          }
        } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".gguf")) {
          paths.push(path.resolve(candidatePath));
        }
        if (entriesScanned % 250 === 0) report();
      }
      report();
    };

    for (const root of this.fullScanRoots()) {
      await visit(root, 0);
      if (stopped) break;
    }
    report();
    return { paths, truncated };
  }

  private async runLocalModelScan(scanId: string, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const config = this.store.get();
    const models: LocalModelCandidate[] = [];
    const seenModels = new Set<string>();
    const inspectedPaths = new Set<string>();
    const addModel = (candidate: LocalModelCandidate) => {
      if (seenModels.has(candidate.path)) return;
      seenModels.add(candidate.path);
      models.push(candidate);
    };
    const sortedModels = () => [...models].sort(
      (left, right) => Number(right.selected) - Number(left.selected)
        || Number(right.compatibility.status === "compatible") - Number(left.compatibility.status === "compatible")
        || right.sizeBytes - left.sizeBytes
        || left.name.localeCompare(right.name)
    );
    const combineWarnings = (...messages: Array<string | null>) => messages.filter(Boolean).join(" ") || null;
    const validatePaths = async (paths: string[]): Promise<number> => {
      let discovered = 0;
      let inspected = 0;
      for (const filePath of paths) {
        if (signal.aborted) throw scanAbortError();
        const absolutePath = path.resolve(filePath);
        if (inspectedPaths.has(absolutePath)) continue;
        inspectedPaths.add(absolutePath);
        inspected += 1;
        const candidate = await this.inspectLocalModel(absolutePath, config.model.path);
        if (signal.aborted) throw scanAbortError();
        if (candidate) {
          discovered += 1;
          addModel(candidate);
        }
        if (inspected % 10 === 0 || inspected === paths.length) {
          this.updateLocalModelScan(scanId, {
            progress: { modelsFound: models.length },
            models: sortedModels()
          });
        }
      }
      return discovered;
    };

    try {
      const selected = await this.inspectLocalModel(config.model.path, config.model.path);
      if (selected) addModel(selected);
      this.updateLocalModelScan(scanId, {
        progress: { modelsFound: models.length },
        models: sortedModels()
      });

      const spotlight = await this.spotlightGgufPaths(signal, (candidateFiles) => {
        this.updateLocalModelScan(scanId, { progress: { candidateFiles } });
      });
      let warning: string | null = null;
      let truncated = spotlight?.truncated ?? false;
      if (spotlight?.paths.length) {
        this.updateLocalModelScan(scanId, {
          stage: "validating",
          strategy: "spotlight",
          progress: { candidateFiles: spotlight.paths.length }
        });
        const discovered = await validatePaths(spotlight.paths);
        if (discovered > 0) {
          if (signal.aborted) throw scanAbortError();
          await this.reconcileLocalModelInventory(models);
          warning = combineWarnings(
            spotlight.truncated ? "Spotlight returned more than 1,000 GGUF paths. Use Finder if your model is not listed." : null
          );
          this.updateLocalModelScan(scanId, {
            status: "complete",
            stage: "complete",
            completedAt: new Date().toISOString(),
            models: sortedModels(),
            truncated,
            warning,
            progress: { modelsFound: models.length }
          });
          return;
        }
      }

      this.updateLocalModelScan(scanId, {
        stage: "filesystem",
        strategy: "filesystem-fallback",
        progress: { directoriesScanned: 0, entriesScanned: 0, candidateFiles: 0 }
      });
      const fallback = await this.filesystemGgufPaths(signal, (progress) => {
        this.updateLocalModelScan(scanId, { progress });
      });
      truncated = truncated || fallback.truncated;
      this.updateLocalModelScan(scanId, {
        stage: "validating",
        progress: { candidateFiles: fallback.paths.length }
      });
      await validatePaths(fallback.paths);
      if (signal.aborted) throw scanAbortError();
      await this.reconcileLocalModelInventory(models);
      warning = combineWarnings(
        fallback.truncated ? "The disk scan reached its safety limit; use Finder if your model is not listed." : null
      );
      this.updateLocalModelScan(scanId, {
        status: "complete",
        stage: "complete",
        completedAt: new Date().toISOString(),
        models: sortedModels(),
        truncated,
        warning,
        progress: { modelsFound: models.length }
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        let warning = this.localModelScan.warning;
        try {
          await this.reconcileLocalModelInventory(models);
        } catch {
          warning = "The scan stopped, but DSBox could not save the models found before cancellation.";
        }
        this.updateLocalModelScan(scanId, {
          status: "cancelled",
          stage: "idle",
          completedAt: new Date().toISOString(),
          models: sortedModels(),
          warning,
          error: null,
          progress: { modelsFound: models.length }
        });
        return;
      }
      this.updateLocalModelScan(scanId, {
        status: "error",
        stage: "idle",
        completedAt: new Date().toISOString(),
        models: sortedModels(),
        error: error instanceof Error ? error.message : String(error),
        progress: { modelsFound: models.length }
      });
    } finally {
      if (this.localModelScanController === controller) this.localModelScanController = null;
    }
  }

  startLocalModelScan(): LocalModelScanSnapshot {
    if (this.localModelScan.status === "scanning") return this.getLocalModelScan();
    const scanId = `${Date.now().toString(36)}-${this.nextLocalModelScanId++}`;
    const controller = new AbortController();
    this.localModelScanController = controller;
    this.localModelScan = {
      ...structuredClone(initialLocalModelScan),
      id: scanId,
      status: "scanning",
      stage: "spotlight",
      startedAt: new Date().toISOString()
    };
    void this.runLocalModelScan(scanId, controller);
    return this.getLocalModelScan();
  }

  cancelLocalModelScan(): LocalModelScanSnapshot {
    const controller = this.localModelScanController;
    if (!controller || this.localModelScan.status !== "scanning") return this.getLocalModelScan();
    controller.abort();
    this.updateLocalModelScan(this.localModelScan.id!, {
      status: "cancelled",
      stage: "idle",
      completedAt: new Date().toISOString(),
      error: null
    });
    return this.getLocalModelScan();
  }

  async chooseLocalModelFromFinder(
    chooser: () => Promise<string | null> = chooseGgufFileInFinder
  ): Promise<NativeModelSelectionResult> {
    if (this.modelPickerPending) throw new ModelSelectionError("The Finder file chooser is already open", 409);
    this.modelPickerPending = true;
    let selectedPath: string | null;
    try {
      selectedPath = await chooser();
    } finally {
      this.modelPickerPending = false;
    }
    if (!selectedPath) return { cancelled: true, model: null };
    const inspection = await this.inspectLocalModelWithReason(selectedPath, this.store.get().model.path);
    if (!inspection.candidate) {
      throw new ModelSelectionError(inspection.message ?? "This file could not be added to the model library");
    }
    const remembered = await this.reconcileLocalModelInventory([inspection.candidate]);
    return {
      cancelled: false,
      model: remembered.find((model) => model.path === inspection.candidate!.path) ?? inspection.candidate
    };
  }

  async selectLocalModel(filePath: string, modelId?: string): Promise<LocalModelCandidate> {
    if (this.modelChangeBlocked() || this.modelSelectionPending) {
      throw new ModelSelectionError("Cancel the download or turn off DSBox before changing models", 409);
    }
    if (!path.isAbsolute(filePath)) throw new ModelSelectionError("DSBox did not receive a valid model location");
    this.modelSelectionPending = true;
    try {
      const candidate = await this.validateLocalModel(filePath);
      if (this.modelChangeBlocked()) {
        throw new ModelSelectionError("DSBox started another operation; try again after it is turned off", 409);
      }
      const saved = await this.persistLocalModel(candidate, this.localModelId(candidate, modelId));
      this.log("success", "dsbox", `${candidate.name} selected from this Mac. No download required.`);
      this.setState({ phase: this.state.installed ? "idle" : "uninstalled", currentTask: null, lastError: null, readiness: "offline" });
      await this.refresh();
      return { ...candidate, modelId: saved.model.id, selected: true };
    } finally {
      this.modelSelectionPending = false;
    }
  }

  private async persistLocalModel(candidate: LocalModelCandidate, modelId: string) {
    const next = this.store.get();
    next.model.path = candidate.path;
    next.model.id = modelId;
    const saved = await this.store.set(next);
    this.bus.publish({ type: "config", payload: saved });
    try {
      await this.reconcileLocalModelInventory([{ ...candidate, modelId, selected: true }]);
    } catch (error) {
      this.log("warn", "dsbox", `The model was selected, but its local inventory entry could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
    return saved;
  }

  async rememberLocalModel(filePath: string, modelId?: string): Promise<LocalModelCandidate | null> {
    const config = this.store.get();
    const candidate = await this.inspectLocalModel(filePath, config.model.path);
    if (!candidate) return null;
    const models = await this.reconcileLocalModelInventory([{
      ...candidate,
      modelId: this.localModelId(candidate, modelId)
    }]);
    return models.find((model) => model.path === candidate.path) ?? null;
  }

  async switchLocalModel(filePath: string, modelId?: string): Promise<LocalModelSwitchResult> {
    const running = Boolean(this.engine) && this.state.phase === "running";
    const engineInTransition = Boolean(this.engine) && !running;
    if (
      this.modelSwitchPending
      || this.modelSelectionPending
      || this.task
      || this.startPending
      || this.stopping
      || this.state.phase === "preparing"
      || engineInTransition
    ) {
      throw new ModelSelectionError("Wait for the current DSBox operation to finish before switching models", 409);
    }
    if (!path.isAbsolute(filePath)) throw new ModelSelectionError("DSBox did not receive a valid model location");

    this.modelSwitchPending = true;
    const previous = this.store.get();
    try {
      const candidate = await this.validateLocalModel(filePath);
      const requestedModelId = modelId?.trim();
      if (requestedModelId && requestedModelId.length > 160) {
        throw new ModelSelectionError("The model ID must be 160 characters or fewer");
      }
      const nextModelId = this.localModelId(candidate, requestedModelId);
      if (candidate.path === path.resolve(previous.model.path) && nextModelId === previous.model.id) {
        return { model: { ...candidate, modelId: nextModelId, selected: true }, changed: false, restarted: false };
      }

      try {
        if (running) {
          await this.stopEngine();
          if (this.engine) throw new Error("The previous DS4 process did not finish shutting down");
        }

        const saved = await this.persistLocalModel(candidate, nextModelId);
        this.setState({
          phase: this.state.installed ? "idle" : "uninstalled",
          readiness: "offline",
          currentTask: null,
          lastError: null
        });
        await this.refresh();
        if (running) await this.startManaged(true);
        this.log(
          "success",
          "dsbox",
          running
            ? `${candidate.name} selected. DS4 is restarting with the new model.`
            : `${candidate.name} selected. It will be used the next time DS4 starts.`
        );
        return {
          model: { ...candidate, modelId: saved.model.id, selected: true },
          changed: true,
          restarted: running
        };
      } catch (error) {
        const current = this.store.get();
        const configNeedsRollback = current.model.path !== previous.model.path || current.model.id !== previous.model.id;
        let rolledBack = !configNeedsRollback;
        let runtimeRestored = running && Boolean(this.engine) && this.state.phase === "running";
        const rollbackFailures: string[] = [];

        if (configNeedsRollback) {
          try {
            const restored = await this.store.set(previous);
            this.bus.publish({ type: "config", payload: restored });
            await this.refresh();
            rolledBack = true;
          } catch (rollbackError) {
            rollbackFailures.push(`configuration rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }

        if (running && !this.engine && rolledBack) {
          try {
            await this.startManaged(true);
            runtimeRestored = true;
          } catch (restartError) {
            rollbackFailures.push(`previous model could not restart: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
          }
        }
        if (running && this.engine && !runtimeRestored) {
          rollbackFailures.push("the previous runtime is still shutting down");
        }

        const reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, "");
        const recovery = rollbackFailures.length
          ? ` Recovery was incomplete (${rollbackFailures.join("; ")}).`
          : running
            ? " The previous model selection was restored and DS4 was relaunched."
            : " The previous model selection was restored.";
        const message = `Could not switch to ${candidate.name}: ${reason}.${recovery}`;
        this.log("error", "dsbox", message);
        throw new ModelSwitchError(message, rolledBack, runtimeRestored);
      }
    } finally {
      this.modelSwitchPending = false;
    }
  }

  async cancelTask(): Promise<boolean> {
    const child = this.task;
    if (!child) return false;
    this.log("warn", "dsbox", "Cancellation requested. Downloads can resume the next time they are started.");
    this.cancelledTasks.add(child);
    this.setState({ currentTask: "Cancelling" });
    const signal = (name: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, name);
          return;
        } catch {
          // Fall back to signaling the direct child.
        }
      }
      try {
        child.kill(name);
      } catch {
        // The process may have exited between the state check and the signal.
      }
    };
    signal("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      if (this.task !== child) {
        resolve();
        return;
      }
      let forceTimer: NodeJS.Timeout | null = null;
      let failTimer: NodeJS.Timeout | null = null;
      const done = () => {
        if (forceTimer) clearTimeout(forceTimer);
        if (failTimer) clearTimeout(failTimer);
        resolve();
      };
      child.once("exit", done);
      child.once("error", done);
      forceTimer = setTimeout(() => signal("SIGKILL"), 5_000);
      failTimer = setTimeout(() => {
        child.off("exit", done);
        child.off("error", done);
        reject(new Error("The process did not respond to the cancellation request"));
      }, 8_000);
      forceTimer.unref();
      failTimer.unref();
    });
    return true;
  }

  private async detectHelp(binary: string, cwd: string): Promise<string> {
    try {
      const result = await execFileAsync(binary, ["--help", "all"], {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 15_000
      });
      return `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
      if (output.trim()) return output;
      throw new Error("Unable to read ds4-server capabilities");
    }
  }

  private validateCapabilities(args: string[], help: string): void {
    const unsupported = [...new Set(args.filter(isOptionToken).map(optionName))]
      .filter((option) => !["-m", "-c", "-n", "-t"].includes(option))
      .filter((option) => !help.includes(option));
    if (unsupported.length) {
      throw new Error(`Flags not supported by the selected checkout: ${unsupported.join(", ")}`);
    }
  }

  private async startManaged(modelSwitch = false): Promise<void> {
    if (this.engine || this.task || this.startPending || this.modelSelectionPending || (this.modelSwitchPending && !modelSwitch)) {
      throw new Error("A DS4 process or operation is already active");
    }
    this.startPending = true;
    try {
      await this.startEngine(modelSwitch);
    } catch (error) {
      this.failOneClickStart(error);
      throw error;
    } finally {
      this.startPending = false;
    }
  }

  async start(): Promise<void> {
    await this.startManaged();
  }

  private async checkoutHasExpertMajorV2Source(directory: string): Promise<boolean> {
    try {
      const [header, implementation] = await Promise.all([
        readFile(path.join(directory, "ds4_expert_store.h"), "utf8"),
        readFile(path.join(directory, "ds4.c"), "utf8")
      ]);
      return header.includes('DS4_EXPERT_STORE_V2_TENSOR "ds4.expert_major.v2"')
        && header.includes("DS4_EXPERT_STORE_FAMILY_DEEPSEEK4")
        && header.includes("DS4_EXPERT_STORE_FAMILY_GLM_DSA")
        && header.includes("DS4_EXPERT_STORE_FAMILY_QWEN35_MOE")
        && implementation.includes("model_expand_deepseek4_native_expert_store")
        && implementation.includes("model_expand_glm_native_expert_store")
        && implementation.includes("model_expand_qwen35_expert_store_v2")
        && implementation.includes("Qwen inference requires a DS4 ExpertMajor v2 GGUF")
        && implementation.includes("DeepSeek inference requires a DS4 ExpertMajor v2 GGUF")
        && implementation.includes("GLM inference requires a DS4 ExpertMajor v2 GGUF");
    } catch {
      return false;
    }
  }

  private async binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean> {
    try {
      const binary = await readFile(path.join(directory, "ds4-server"));
      return binary.includes(Buffer.from("ds4.expert_major.v2"))
        && binary.includes(Buffer.from("Qwen inference requires a DS4 ExpertMajor v2 GGUF"))
        && binary.includes(Buffer.from("DeepSeek inference requires a DS4 ExpertMajor v2 GGUF"))
        && binary.includes(Buffer.from("GLM inference requires a DS4 ExpertMajor v2 GGUF"))
        && binary.includes(Buffer.from("embedded expert-major store active"));
    } catch {
      return false;
    }
  }

  private async binaryMatchesCheckoutHead(directory: string): Promise<boolean> {
    if (await this.buildMatchesHead(directory)) return true;
    const checkoutClean = await execFileAsync("git", ["status", "--porcelain"], { cwd: directory })
      .then((result) => !result.stdout.trim())
      .catch(() => false);
    if (!checkoutClean) return false;
    const head = await this.fullGitHead(directory);
    if (!head) return false;
    try {
      const binary = path.join(directory, "ds4-server");
      const result = await execFileAsync(binary, ["--build-info"], {
        cwd: directory,
        maxBuffer: 1024 * 1024,
        timeout: 15_000
      });
      return ds4BuildInfoMatchesHead(`${result.stdout}\n${result.stderr}`, head);
    } catch {
      return false;
    }
  }

  private async checkoutIsClean(directory: string): Promise<boolean> {
    return execFileAsync("git", ["status", "--porcelain"], { cwd: directory })
      .then((result) => !result.stdout.trim())
      .catch(() => false);
  }

  private async ensureExpertMajorRuntimeCheckout(
    config: ReturnType<ConfigStore["get"]>,
    format: Ds4ArtifactFormat,
    allowModelSwitch = false,
    modelIdentity: string | null = null
  ): Promise<ReturnType<ConfigStore["get"]>> {
    if (format !== "ds4-expert-major-v2") {
      throw new Error("DSBox supports only DS4 ExpertMajor v2 runtimes");
    }
    const label = modelIdentity === "qwen35moe" || modelIdentity === QWEN35_MODEL_ID
      ? "Qwen3.6 ExpertMajor v2"
      : modelIdentity === "glm-dsa" || modelIdentity === "glm-5.2"
        ? "GLM-5.2 ExpertMajor v2"
        : "DeepSeek ExpertMajor v2";
    const sourceIsQualified = async (directory: string) =>
      await this.checkoutHasExpertMajorV2Source(directory)
      && await this.runtimeIncludesCommit(directory, EXPERT_MAJOR_RUNTIME_COMMIT);
    const checkoutCanBeBuilt = async (directory: string) => await sourceIsQualified(directory)
      && ((await this.binaryMatchesCheckoutHead(directory)) || await this.checkoutIsClean(directory));

    let selected = config;
    if (!(await checkoutCanBeBuilt(selected.repository.directory))) {
      let checkout: { path: string; branch: string | null } | null = null;
      for (const candidate of await this.discoveredCheckouts()) {
        if (candidate.path === selected.repository.directory) continue;
        if (await checkoutCanBeBuilt(candidate.path)) {
          checkout = candidate;
          break;
        }
      }
      if (checkout) {
        const next = structuredClone(selected);
        next.repository.url = "https://github.com/andreaborio/ds4.git";
        next.repository.directory = checkout.path;
        if (checkout.branch) next.repository.branch = checkout.branch;
        selected = await this.store.set(next);
        this.bus.publish({ type: "config", payload: selected });
        this.log("info", "dsbox", `Using the qualified ${label} runtime at ${checkout.path}.`);
        await this.refresh();
      } else {
        const targetBranch = EXPERT_MAJOR_RUNTIME_BRANCH;
        const targetDirectory = "andreaborio-ds4";
        const gitDirectory = path.join(selected.repository.directory, ".git");
        const currentIsManagedTarget = selected.repository.url === "https://github.com/andreaborio/ds4.git"
          && selected.repository.branch === targetBranch
          && (!(await this.pathExists(gitDirectory)) || await this.checkoutIsClean(selected.repository.directory));
        if (!currentIsManagedTarget) {
          const next = structuredClone(selected);
          next.repository.url = "https://github.com/andreaborio/ds4.git";
          next.repository.branch = targetBranch;
          next.repository.directory = path.join(this.store.homeDirectory, "runtime", targetDirectory);
          selected = await this.store.set(next);
          this.bus.publish({ type: "config", payload: selected });
          await this.refresh();
        }
        this.log(
          "info",
          "git",
          `Preparing the unified DS4 main runtime for ${label} at ${EXPERT_MAJOR_RUNTIME_COMMIT.slice(0, 9)} or newer.`
        );
        await this.installOrUpdate(allowModelSwitch);
        selected = this.store.get();
      }
    }

    if (!(await sourceIsQualified(selected.repository.directory))) {
      throw new Error(`DS4 main does not include the unified ExpertMajor v2 runtime ${EXPERT_MAJOR_RUNTIME_COMMIT.slice(0, 9)} required by ${label}`);
    }
    const binaryIsQualified = async () => await this.binaryMatchesCheckoutHead(selected.repository.directory)
      && await this.binaryHasExpertMajorV2Runtime(selected.repository.directory);
    if (!(await binaryIsQualified())) {
      this.log("info", "build", `Building the ${label} runtime for this Mac.`);
      await this.build(allowModelSwitch);
      selected = this.store.get();
    }
    if (!(await binaryIsQualified())) {
      throw new Error(`The selected DS4 binary does not match the qualified ${label} checkout`);
    }
    return selected;
  }

  private async startEngine(modelSwitch = false): Promise<void> {
    let config = this.store.get();
    const selectedModel = await this.validateLocalModel(config.model.path, config.model.path);
    const modelId = this.localModelId(selectedModel, config.model.id);
    if (modelId !== config.model.id) {
      const next = structuredClone(config);
      next.model.id = modelId;
      config = await this.store.set(next);
      this.bus.publish({ type: "config", payload: config });
    }
    const qwen35 = selectedModel.architecture === QWEN35_ARCHITECTURE;
    const glm52 = selectedModel.architecture === GLM52_ARCHITECTURE;
    if (selectedModel.artifactFormat) {
      config = await this.ensureExpertMajorRuntimeCheckout(
        config,
        selectedModel.artifactFormat,
        modelSwitch,
        selectedModel.architecture
      );
    }
    await this.ensureAppleMetalToolchain();
    const binary = path.join(config.repository.directory, "ds4-server");
    if (!(await this.pathExists(binary, true))) throw new Error("ds4-server has not been built");
    let modelStat;
    try {
      modelStat = await stat(config.model.path);
    } catch {
      throw new Error("The selected GGUF model does not exist");
    }
    if (!modelStat.isFile()) throw new Error("The model path does not point to a GGUF file");

    const hasAdvancedCacheOverride = tokenizeArguments(config.advanced.extraArgs)
      .some((value) => optionName(value) === "--ssd-streaming-cache-experts");
    const usesAutomaticMemoryPlan = qwen35 || glm52 || (
      config.streaming.enabled
      && config.streaming.cacheMode === "auto"
      && !hasAdvancedCacheOverride
    );
    const args = buildEngineArguments(config, selectedModel.architecture);
    const help = await this.detectHelp(binary, config.repository.directory);
    this.validateCapabilities(args, help);
    await this.ensurePortAvailable(config.server.internalHost, config.server.internalPort);
    if (config.kvCache.enabled) await mkdir(config.kvCache.directory, { recursive: true, mode: 0o700 });
    if (config.observability.traceEnabled) await mkdir(path.dirname(config.observability.tracePath), { recursive: true, mode: 0o700 });
    if (config.observability.imatrixEnabled) await mkdir(path.dirname(config.observability.imatrixPath), { recursive: true, mode: 0o700 });
    const extraEnvironment = parseEnvironment(config.advanced.environment);
    const environment = { ...process.env, ...extraEnvironment };

    this.clearAutomaticMemoryWatchdog();
    this.automaticMemoryGuard = null;
    if (usesAutomaticMemoryPlan) {
      const memory = await this.darwinMemorySafetySnapshot();
      if (!memory) {
        throw new Error("Automatic memory planning could not read macOS memory pressure; refusing an unguarded launch");
      }
      if (memory.pressureLevel !== 1) {
        throw new Error("Automatic memory planning requires normal macOS memory pressure before launch");
      }
      this.automaticMemoryGuard = {
        baselineSwapoutPages: memory.swapoutPages,
        maxSwapoutDeltaPages: 64,
        consecutiveReadFailures: 0,
        triggered: false
      };
      this.log(
        "info",
        "dsbox",
        qwen35
          ? "DS4 Qwen AUTO residency enabled; DSBox pressure/swap watchdog armed at 1 Hz."
          : glm52
            ? "DS4 GLM automatic SSD/cache plan and gold profile enabled; DSBox pressure/swap watchdog armed at 1 Hz."
            : "DS4 adaptive cache planner enabled; DSBox pressure/swap watchdog armed at 1 Hz."
      );
    }

    const command = [binary, ...args];
    if (qwen35) this.log("info", "dsbox", "Qwen3.6 profile applied: Metal AUTO residency, resident when safe with SSD fallback, power 100, and tool-enabled chat.");
    this.log("info", "dsbox", `$ ${command.map(shellDisplayArgument).join(" ")}`);
    this.setState({
      phase: "starting",
      readiness: "loading",
      currentTask: "Loading the model and Metal graph",
      lastError: null,
      command,
      startedAt: new Date().toISOString()
    });

    const child = spawn(binary, args, {
      cwd: config.repository.directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.engine = child;
    this.stopping = false;
    this.setState({ pid: child.pid ?? null });
    this.streamLines(child, "ds4", "runtime");

    child.once("error", (error) => {
      this.log("error", "ds4", error.message);
    });
    child.once("exit", (code, signal) => {
      if (this.readinessTimer) clearInterval(this.readinessTimer);
      this.readinessTimer = null;
      this.clearAutomaticMemoryWatchdog();
      this.engine = null;
      this.automaticMemoryGuard = null;
      const wasStopping = this.stopping;
      this.stopping = false;
      const normal = wasStopping || code === 0;
      const message = normal ? null : `ds4-server exited with ${signal ? `signal ${signal}` : `code ${code ?? "?"}`}`;
      if (message) this.log("error", "dsbox", message);
      this.setState({
        phase: normal ? "idle" : "error",
        readiness: "offline",
        pid: null,
        currentTask: null,
        lastError: message,
        startedAt: null
      });
    });

    if (this.automaticMemoryGuard) this.startAutomaticMemoryWatchdog();

    this.readinessTimer = setInterval(async () => {
      if (!this.engine || this.state.readiness === "ready") return;
      try {
        const response = await fetch(`http://${config.server.internalHost}:${config.server.internalPort}/v1/models`, {
          signal: AbortSignal.timeout(900)
        });
        if (!response.ok) return;
        const payload = await response.json() as { data?: Array<{ id?: string }> };
        const modelId = payload.data?.[0]?.id;
        if (modelId && modelId !== config.model.id) {
          this.log("info", "dsbox", `Model exposed by the runtime: ${modelId}`);
        }
        this.log(
          "success",
          "dsbox",
          qwen35
            ? "ds4-server is ready for Qwen chat and tool-enabled Chat Completions."
            : "ds4-server is ready for chat and coding agents."
        );
        this.setState({ phase: "running", readiness: "ready", currentTask: null });
        if (this.readinessTimer) clearInterval(this.readinessTimer);
        this.readinessTimer = null;
      } catch {
        // Model loading can legitimately take several minutes.
      }
    }, 1000);
  }

  private async stopEngine(): Promise<void> {
    if (this.automaticSafetyStopPromise) return this.automaticSafetyStopPromise;
    if (!this.engine) throw new Error("ds4-server is not running");
    if (this.stopping) return;
    if (this.readinessTimer) clearInterval(this.readinessTimer);
    this.readinessTimer = null;
    this.clearAutomaticMemoryWatchdog();
    this.stopping = true;
    this.setState({ phase: "stopping", currentTask: "Saving KV cache and stopping" });
    this.log("info", "dsbox", "Sending SIGTERM so ds4 can finish the active request and save the KV cache.");
    const child = this.engine;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.log("warn", "dsbox", "The runtime is still shutting down; no automatic force-kill was performed.");
        resolve();
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.modelSwitchPending) throw new Error("A model switch is already in progress");
    await this.stopEngine();
  }

  async forceStop(): Promise<void> {
    if (this.modelSwitchPending) throw new Error("A model switch is already in progress");
    if (!this.engine) throw new Error("ds4-server is not running");
    this.log("warn", "dsbox", "Force stop requested; the latest KV checkpoint may not be saved.");
    this.clearAutomaticMemoryWatchdog();
    this.stopping = true;
    this.engine.kill("SIGKILL");
  }

  async restart(): Promise<void> {
    if (this.modelSwitchPending) throw new Error("A model switch is already in progress");
    if (this.engine) await this.stop();
    if (this.engine) throw new Error("The previous process has not stopped yet");
    await this.start();
  }

  async oneClickStart(recommendedModel: CatalogModel | null = null): Promise<void> {
    if (this.engine || this.task) throw new Error("DS4 is already busy with another operation");
    try {
      let state = await this.refresh();
      if (!state.modelPresent) {
        throw new Error("No model is ready. Choose a GGUF file already on this Mac or explicitly start a download from the DSBox catalog.");
      }
      const configured = this.store.get();
      const selectedModel = await this.validateLocalModel(configured.model.path, configured.model.path);
      if (selectedModel.artifactFormat) {
        await this.ensureExpertMajorRuntimeCheckout(
          configured,
          selectedModel.artifactFormat,
          false,
          selectedModel.architecture
        );
        state = await this.refresh();
      }
      if (!state.installed) {
        await this.installOrUpdate();
        state = await this.refresh();
      }
      if (!state.built) {
        await this.build();
        state = await this.refresh();
      }

      if (recommendedModel) {
        const config = this.store.get();
        const repositoryName = recommendedModel.repository.split("/").at(-1)!;
        const recommendedDirectory = path.resolve(this.store.homeDirectory, "models", repositoryName, recommendedModel.revision);
        const selectedModel = path.resolve(config.model.path);
        if (selectedModel.startsWith(`${recommendedDirectory}${path.sep}`)) {
          await this.ensureCatalogRuntime(recommendedModel);
          state = await this.refresh();
        }
      }

      if (!state.built || !state.modelPresent) {
        throw new Error("Automatic setup did not finish preparing the engine and model");
      }
      await this.start();
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.setState({ phase: this.state.installed ? "idle" : "uninstalled", readiness: "offline", currentTask: null, lastError: null });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.state.lastError !== message) this.log("error", "dsbox", message);
      if (!this.engine && !this.task) {
        this.setState({ phase: "error", readiness: "offline", currentTask: null, lastError: message });
      }
      throw error;
    }
  }

  async commandPreview(): Promise<string[]> {
    const config = this.store.get();
    const selectedModel = await this.inspectLocalModel(config.model.path, config.model.path);
    return [
      path.join(config.repository.directory, "ds4-server"),
      ...buildEngineArguments(config, selectedModel?.architecture)
    ];
  }

  async discoveredCheckouts(): Promise<Array<{ path: string; branch: string | null; head: string | null }>> {
    const home = process.env.HOME ?? "";
    const configured = this.store.get().repository.directory;
    const roots = [...new Set([
      path.dirname(configured),
      path.join(this.store.homeDirectory, "runtime"),
      path.join(home, "Beep"),
      path.join(home, "BEEP"),
      path.join(home, "Documents"),
      path.join(home, "Developer")
    ])];
    const nearby: string[] = [];
    for (const root of roots) {
      try {
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !/(^|[-_.])ds4(?:[-_.]|$)/i.test(entry.name)) continue;
          nearby.push(path.join(root, entry.name));
        }
      } catch {
        // Discovery is best-effort; configured and managed paths remain below.
      }
    }
    const candidates = [...new Set([
      configured,
      path.join(this.store.homeDirectory, "runtime", "andreaborio-ds4-qwen35"),
      path.join(home, "Beep", "ds4"),
      path.join(home, "Beep", "ds4-qwen-support"),
      path.join(home, "Beep", "ds4-glm52-gold"),
      path.join(home, "BEEP", "ds4"),
      ...nearby.sort()
    ])];
    const found: Array<{ path: string; branch: string | null; head: string | null }> = [];
    for (const candidate of candidates) {
      if (!(await this.pathExists(path.join(candidate, ".git")))) continue;
      try {
        const remote = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: candidate });
        if (!remote.stdout.includes("andreaborio/ds4")) continue;
      } catch {
        continue;
      }
      const [branch, head] = await Promise.all([
        execFileAsync("git", ["branch", "--show-current"], { cwd: candidate }).then((result) => result.stdout.trim() || null).catch(() => null),
        execFileAsync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: candidate }).then((result) => result.stdout.trim() || null).catch(() => null)
      ]);
      found.push({ path: candidate, branch, head });
    }
    return found;
  }
}
