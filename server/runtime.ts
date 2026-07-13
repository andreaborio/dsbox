import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { access, lstat, mkdir, open, readFile, readdir, rename, stat, statfs, writeFile } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import type {
  CatalogModel,
  DsboxConfig,
  LocalModelCandidate,
  LocalModelScanSnapshot,
  LogEntry,
  NativeModelSelectionResult,
  RuntimeState
} from "../src/types.js";
import { ConfigStore } from "./config.js";
import { EventBus } from "./event-bus.js";
import { chooseGgufFileInFinder } from "./native-file-picker.js";

const execFileAsync = promisify(execFile);
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;
const ansiPattern = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const fallbackModelVariables: Record<string, string> = {
  "q2-imatrix": "Q2_IMATRIX_FILE",
  "q2-q4-imatrix": "Q2_Q4_IMATRIX_FILE",
  "q4-imatrix": "Q4_IMATRIX_FILE",
  "pro-q2-imatrix": "PRO_Q2_IMATRIX_FILE"
};

export function parseFallbackModelFilename(script: string, variant: string): string | null {
  const variable = fallbackModelVariables[variant];
  if (!variable) return null;
  const match = script.match(new RegExp(`^${variable}=(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`, "m"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function remainingDownloadBytes(estimatedBytes: number, partialBytes: number): number {
  return Math.max(0, estimatedBytes - Math.max(0, partialBytes));
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
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.name = "ModelSelectionError";
    this.status = status;
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

export function tokenizeArguments(input: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = () => {
    if (token.length > 0) result.push(token);
    token = "";
  };

  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    token += character;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Unclosed quotation mark in advanced flags");
  push();
  return result;
}

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

export function buildEngineArguments(config: DsboxConfig): string[] {
  const args = [
    "--metal",
    "-m", config.model.path,
    "--ctx", String(config.server.contextTokens),
    "--tokens", String(config.server.maxOutputTokens),
    "--threads", String(config.server.threads),
    "--power", String(config.server.powerPercent),
    "--host", config.server.internalHost,
    "--port", String(config.server.internalPort)
  ];

  if (config.streaming.enabled) {
    args.push("--ssd-streaming");
    if (config.streaming.cacheMode === "manual") {
      args.push("--ssd-streaming-cache-experts", `${config.streaming.cacheSizeGb}GB`);
    }
    if (config.streaming.coldStart) args.push("--ssd-streaming-cold");
    if (config.streaming.preloadExperts !== null) {
      args.push("--ssd-streaming-preload-experts", String(config.streaming.preloadExperts));
    }
  }

  if (config.server.prefillChunk !== null) {
    args.push("--prefill-chunk", String(config.server.prefillChunk));
  }
  if (config.server.quality) args.push("--quality");
  if (config.server.warmWeights) args.push("--warm-weights");

  if (config.kvCache.enabled) {
    args.push(
      "--kv-disk-dir", config.kvCache.directory,
      "--kv-disk-space-mb", String(config.kvCache.spaceMb),
      "--kv-cache-min-tokens", String(config.kvCache.minTokens),
      "--kv-cache-continued-interval-tokens", String(config.kvCache.continuedIntervalTokens)
    );
  }

  if (config.observability.traceEnabled) {
    args.push("--trace", config.observability.tracePath);
  }
  if (config.observability.imatrixEnabled) {
    args.push(
      "--imatrix-out", config.observability.imatrixPath,
      "--imatrix-every", String(config.observability.imatrixEvery)
    );
  }

  args.push(...tokenizeArguments(config.advanced.extraArgs));
  return args;
}

function shellDisplay(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function isOptionToken(value: string): boolean {
  return value.startsWith("--") || /^-[A-Za-z]$/.test(value);
}

function optionName(value: string): string {
  return value.split("=", 1)[0];
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
  private modelPickerPending = false;
  private localModelScan = structuredClone(initialLocalModelScan);
  private localModelScanController: AbortController | null = null;
  private nextLocalModelScanId = 1;
  private readonly cancelledTasks = new WeakSet<ManagedChild>();

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

  private modelChangeBlocked(): boolean {
    return Boolean(this.task || this.engine || this.startPending || this.state.phase === "preparing");
  }

  prepareOneClickStart(): void {
    if (this.engine || this.task || this.startPending || this.modelSelectionPending || this.state.phase === "preparing") throw new Error("DSBox is already working");
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
    const config = this.store.get();
    const gitDirectory = path.join(config.repository.directory, ".git");
    const binary = path.join(config.repository.directory, "ds4-server");
    const installed = await this.pathExists(gitDirectory);
    const built = installed && await this.pathExists(binary, true);
    let modelPresent = false;
    let modelSizeBytes = 0;
    try {
      const modelStat = await stat(config.model.path);
      modelPresent = modelStat.isFile();
      modelSizeBytes = modelStat.size;
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
    this.log("info", source, `$ ${[command, ...args].map(shellDisplay).join(" ")}`);
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

  async installOrUpdate(): Promise<void> {
    if (this.task || this.engine) throw new Error("Stop the runtime before updating");
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

  async build(): Promise<void> {
    if (this.task || this.engine) throw new Error("Stop the runtime before building");
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
    if (this.task || this.engine) throw new Error("Stop the runtime before downloading a model");
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

  async downloadCatalogModel(model: CatalogModel): Promise<void> {
    if (!["andreaborio", "unsloth"].some((publisher) => model.repository.startsWith(`${publisher}/`))) {
      throw new Error("The catalog only accepts models from configured Hugging Face sources");
    }
    if (!model.installable || !model.outputFile || model.files.length !== 1) {
      throw new Error(model.unavailableReason || "This model does not support automatic installation yet");
    }
    if (this.task || this.engine) throw new Error("Turn off DS4 before changing models");
    if (!/^[a-f0-9]{40,64}$/i.test(model.revision)) throw new Error("Invalid Hugging Face revision");
    const config = this.store.get();
    if (model.runtimeBranch && model.runtimeBranch !== config.repository.branch) {
      throw new Error(`This model requires the ${model.runtimeBranch} channel`);
    }
    if (model.runtimeBranch && await this.pathExists(path.join(config.repository.directory, ".git"))) {
      const actualBranch = await execFileAsync("git", ["branch", "--show-current"], { cwd: config.repository.directory })
        .then((result) => result.stdout.trim())
        .catch(() => "");
      if (actualBranch && actualBranch !== model.runtimeBranch) {
        throw new Error(`The installed engine uses the ${actualBranch} channel; this model requires ${model.runtimeBranch}`);
      }
    }
    await this.ensureCatalogRuntime(model);
    const filename = path.basename(model.outputFile);
    if (!filename.toLowerCase().endsWith(".gguf")) throw new Error("The selected file is not a GGUF");
    const repositoryName = model.repository.split("/").at(-1)!;
    const destinationDirectory = path.join(this.store.homeDirectory, "models", repositoryName, model.revision);
    const destination = path.join(destinationDirectory, filename);
    const partial = `${destination}.partial`;
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });

    const expectedBytes = model.files[0]?.sizeBytes ?? 0;
    const expectedSha256 = model.files[0]?.sha256?.toLowerCase() ?? null;
    let partialBytes = 0;
    try {
      partialBytes = (await stat(partial)).size;
    } catch {
      // No resumable partial yet.
    }
    await this.ensureDiskSpace(destinationDirectory, Math.max(0, expectedBytes - partialBytes));
    try {
      const existing = await stat(destination);
      const sizeMatches = !expectedBytes || existing.size === expectedBytes;
      const checksumMatches = sizeMatches && (!expectedSha256 || await this.sha256(destination) === expectedSha256);
      if (checksumMatches) {
        const next = this.store.get();
        next.model.path = destination;
        next.model.id = model.modelId;
        const saved = await this.store.set(next);
        this.bus.publish({ type: "config", payload: saved });
        this.log("success", "dsbox", `${model.label} is already available on this Mac.`);
        await this.refresh();
        return;
      }
      this.log("warn", "download", "The local file does not match the catalog revision and will be downloaded again.");
    } catch {
      // Download or resume below.
    }

    this.setState({ phase: "downloading", currentTask: `Downloading ${model.label}`, lastError: null });
    try {
      const encodedRepository = model.repository.split("/").map(encodeURIComponent).join("/");
      const encodedFile = model.outputFile.split("/").map(encodeURIComponent).join("/");
      const url = `https://huggingface.co/${encodedRepository}/resolve/${encodeURIComponent(model.revision)}/${encodedFile}?download=true`;
      await this.runTask(
        "/usr/bin/curl",
        ["--location", "--fail", "--retry", "4", "--retry-delay", "2", "--continue-at", "-", "--output", partial, url],
        destinationDirectory,
        "download"
      );
      const completed = await stat(partial);
      if (expectedBytes && completed.size !== expectedBytes) {
        throw new Error(`Incomplete download: received ${completed.size} bytes, expected ${expectedBytes}`);
      }
      if (expectedSha256) {
        const actualSha256 = await this.sha256(partial);
        if (actualSha256 !== expectedSha256) {
          await rename(partial, `${partial}.corrupt-${Date.now()}`);
          throw new Error("Invalid model SHA-256 checksum; the incomplete file was isolated");
        }
      }
      await rename(partial, destination);
      const next = this.store.get();
      next.model.path = destination;
      next.model.id = model.modelId;
      const saved = await this.store.set(next);
      this.bus.publish({ type: "config", payload: saved });
      this.log("success", "dsbox", `${model.label} is ready.`);
      this.setState({ phase: "idle", currentTask: null, lastError: null });
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.log("info", "dsbox", "Download cancelled. The partial file is preserved for resuming later.");
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

  private inferLocalModelId(filePath: string): string {
    const filename = path.basename(filePath, path.extname(filePath));
    if (/glm[-_. ]?5[._-]?2/i.test(filename) || /glm52/i.test(filename)) return "glm-5.2";
    if (/deepseek[-_. ]?v?4/i.test(filename)) return "deepseek-v4-flash";
    return filename.slice(0, 160) || "local-model";
  }

  private async inspectLocalModel(filePath: string, selectedPath: string): Promise<LocalModelCandidate | null> {
    const absolutePath = path.resolve(filePath);
    if (!absolutePath.toLowerCase().endsWith(".gguf")) return null;
    const filename = path.basename(absolutePath);
    if (/\.(?:head(?:er)?\w*|partial|part)\.gguf$/i.test(filename)) return null;
    try {
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size < 8) return null;
      const hasGgufMagic = async (target: string) => {
        const handle = await open(target, "r");
        const magic = Buffer.alloc(4);
        try {
          await handle.read(magic, 0, magic.length, 0);
        } finally {
          await handle.close();
        }
        return magic.toString("ascii") === "GGUF";
      };
      if (!(await hasGgufMagic(absolutePath))) return null;

      const shard = filename.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
      let modelName = path.basename(absolutePath, ".gguf");
      let sizeBytes = info.size;
      if (shard) {
        const shardIndex = Number(shard[2]);
        const shardCount = Number(shard[3]);
        if (shardIndex !== 1 || shardCount < 2 || shardCount > 999) return null;
        sizeBytes = 0;
        for (let index = 1; index <= shardCount; index += 1) {
          const siblingName = `${shard[1]}-${String(index).padStart(5, "0")}-of-${shard[3]}.gguf`;
          const siblingPath = path.join(path.dirname(absolutePath), siblingName);
          const sibling = await stat(siblingPath);
          if (!sibling.isFile() || sibling.size < 8 || !(await hasGgufMagic(siblingPath))) return null;
          sizeBytes += sibling.size;
        }
        modelName = shard[1];
      }
      return {
        path: absolutePath,
        name: modelName,
        sizeBytes,
        modelId: this.inferLocalModelId(absolutePath),
        selected: absolutePath === path.resolve(selectedPath)
      };
    } catch {
      return null;
    }
  }

  async discoverLocalModels(): Promise<LocalModelCandidate[]> {
    const config = this.store.get();
    const userHome = process.env.NODE_ENV === "test" ? path.dirname(this.store.homeDirectory) : homedir();
    const rawRoots = [
      path.dirname(config.model.path),
      path.join(this.store.homeDirectory, "models"),
      path.join(userHome, "Downloads"),
      path.join(userHome, "Beep"),
      path.join(userHome, "Models"),
      path.join(userHome, ".cache", "huggingface", "hub"),
      path.join(userHome, "Documents")
    ].map((root) => path.resolve(root));
    const roots = [...new Set(rawRoots)];
    const candidates: LocalModelCandidate[] = [];
    const seen = new Set<string>();
    const seenDirectories = new Set<string>();
    const skippedDirectories = new Set([".git", "node_modules", "dist", "dist-server", "build", ".cache"]);
    const deadline = Date.now() + 2_500;
    let scannedEntries = 0;

    const selected = await this.inspectLocalModel(config.model.path, config.model.path);
    if (selected) {
      candidates.push(selected);
      seen.add(selected.path);
    }

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 5 || candidates.length >= 120 || scannedEntries >= 5_000 || Date.now() >= deadline) return;
      const absoluteDirectory = path.resolve(directory);
      if (seenDirectories.has(absoluteDirectory)) return;
      seenDirectories.add(absoluteDirectory);
      let entries;
      try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        scannedEntries += 1;
        if (candidates.length >= 120 || scannedEntries >= 5_000 || Date.now() >= deadline) break;
        const candidatePath = path.join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !skippedDirectories.has(entry.name)) {
            await visit(candidatePath, depth + 1);
          }
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".gguf")) continue;
        const absolutePath = path.resolve(candidatePath);
        if (seen.has(absolutePath)) continue;
        seen.add(absolutePath);
        const candidate = await this.inspectLocalModel(absolutePath, config.model.path);
        if (candidate) candidates.push(candidate);
      }
    };

    for (const root of roots) await visit(root, 0);
    return candidates.sort((left, right) => Number(right.selected) - Number(left.selected) || right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name));
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
    const addModel = (candidate: LocalModelCandidate) => {
      if (seenModels.has(candidate.path)) return;
      seenModels.add(candidate.path);
      models.push(candidate);
    };
    const sortedModels = () => [...models].sort(
      (left, right) => Number(right.selected) - Number(left.selected) || right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name)
    );
    const validatePaths = async (paths: string[]): Promise<number> => {
      const seenPaths = new Set<string>();
      let usable = 0;
      let inspected = 0;
      for (const filePath of paths) {
        if (signal.aborted) throw scanAbortError();
        const absolutePath = path.resolve(filePath);
        if (seenPaths.has(absolutePath)) continue;
        seenPaths.add(absolutePath);
        inspected += 1;
        const candidate = await this.inspectLocalModel(absolutePath, config.model.path);
        if (candidate) {
          usable += 1;
          addModel(candidate);
        }
        if (inspected % 10 === 0 || inspected === paths.length) {
          this.updateLocalModelScan(scanId, {
            progress: { modelsFound: models.length },
            models: sortedModels()
          });
        }
      }
      return usable;
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
        const usable = await validatePaths(spotlight.paths);
        if (usable > 0) {
          if (spotlight.truncated) warning = "Spotlight returned more than 1,000 GGUF paths. Use Finder if your model is not listed.";
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
      if (fallback.truncated) {
        warning = "The disk scan reached its safety limit; use Finder if your model is not listed.";
      }
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
        if (this.localModelScan.status === "scanning") {
          this.updateLocalModelScan(scanId, {
            status: "cancelled",
            stage: "idle",
            completedAt: new Date().toISOString(),
            models: sortedModels(),
            error: null,
            progress: { modelsFound: models.length }
          });
        }
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
    if (this.modelChangeBlocked() || this.modelSelectionPending) {
      throw new ModelSelectionError("Cancel the download or turn off DSBox before changing models", 409);
    }
    if (this.modelPickerPending) throw new ModelSelectionError("The Finder file chooser is already open", 409);
    this.modelPickerPending = true;
    let selectedPath: string | null;
    try {
      selectedPath = await chooser();
    } finally {
      this.modelPickerPending = false;
    }
    if (!selectedPath) return { cancelled: true, model: null };
    return { cancelled: false, model: await this.selectLocalModel(selectedPath) };
  }

  async selectLocalModel(filePath: string, modelId?: string): Promise<LocalModelCandidate> {
    if (this.modelChangeBlocked() || this.modelSelectionPending) {
      throw new ModelSelectionError("Cancel the download or turn off DSBox before changing models", 409);
    }
    if (!path.isAbsolute(filePath)) throw new ModelSelectionError("DSBox did not receive a valid model location");
    this.modelSelectionPending = true;
    try {
      const candidate = await this.inspectLocalModel(filePath, filePath);
      if (!candidate) throw new ModelSelectionError("This file does not exist or is not a readable GGUF");
      if (this.modelChangeBlocked()) {
        throw new ModelSelectionError("DSBox started another operation; try again after it is turned off", 409);
      }
      const next = this.store.get();
      next.model.path = candidate.path;
      next.model.id = modelId?.trim() || candidate.modelId;
      const saved = await this.store.set(next);
      this.bus.publish({ type: "config", payload: saved });
      this.log("success", "dsbox", `${candidate.name} selected from this Mac. No download required.`);
      this.setState({ phase: this.state.installed ? "idle" : "uninstalled", currentTask: null, lastError: null, readiness: "offline" });
      await this.refresh();
      return { ...candidate, modelId: saved.model.id, selected: true };
    } finally {
      this.modelSelectionPending = false;
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

  async start(): Promise<void> {
    if (this.engine || this.task || this.startPending || this.modelSelectionPending) throw new Error("A DS4 process or operation is already active");
    this.startPending = true;
    try {
      await this.startEngine();
    } catch (error) {
      this.failOneClickStart(error);
      throw error;
    } finally {
      this.startPending = false;
    }
  }

  private async startEngine(): Promise<void> {
    await this.ensureAppleMetalToolchain();
    const config = this.store.get();
    const binary = path.join(config.repository.directory, "ds4-server");
    if (!(await this.pathExists(binary, true))) throw new Error("ds4-server has not been built");
    let modelStat;
    try {
      modelStat = await stat(config.model.path);
    } catch {
      throw new Error("The selected GGUF model does not exist");
    }
    if (!modelStat.isFile()) throw new Error("The model path does not point to a GGUF file");

    const args = buildEngineArguments(config);
    const help = await this.detectHelp(binary, config.repository.directory);
    this.validateCapabilities(args, help);
    await this.ensurePortAvailable(config.server.internalHost, config.server.internalPort);
    if (config.kvCache.enabled) await mkdir(config.kvCache.directory, { recursive: true, mode: 0o700 });
    if (config.observability.traceEnabled) await mkdir(path.dirname(config.observability.tracePath), { recursive: true, mode: 0o700 });
    if (config.observability.imatrixEnabled) await mkdir(path.dirname(config.observability.imatrixPath), { recursive: true, mode: 0o700 });
    const extraEnvironment = parseEnvironment(config.advanced.environment);

    this.log("info", "dsbox", `$ ${[binary, ...args].map(shellDisplay).join(" ")}`);
    this.setState({
      phase: "starting",
      readiness: "loading",
      currentTask: "Loading the model and Metal graph",
      lastError: null,
      command: [binary, ...args],
      startedAt: new Date().toISOString()
    });

    const child = spawn(binary, args, {
      cwd: config.repository.directory,
      env: { ...process.env, ...extraEnvironment },
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
      this.engine = null;
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
        this.log("success", "dsbox", "ds4-server is ready for chat and coding agents.");
        this.setState({ phase: "running", readiness: "ready", currentTask: null });
        if (this.readinessTimer) clearInterval(this.readinessTimer);
        this.readinessTimer = null;
      } catch {
        // Model loading can legitimately take several minutes.
      }
    }, 1000);
  }

  async stop(): Promise<void> {
    if (!this.engine) throw new Error("ds4-server is not running");
    if (this.readinessTimer) clearInterval(this.readinessTimer);
    this.readinessTimer = null;
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

  async forceStop(): Promise<void> {
    if (!this.engine) throw new Error("ds4-server is not running");
    this.log("warn", "dsbox", "Force stop requested; the latest KV checkpoint may not be saved.");
    this.stopping = true;
    this.engine.kill("SIGKILL");
  }

  async restart(): Promise<void> {
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
    return [path.join(config.repository.directory, "ds4-server"), ...buildEngineArguments(config)];
  }

  async discoveredCheckouts(): Promise<Array<{ path: string; branch: string | null; head: string | null }>> {
    const home = process.env.HOME ?? "";
    const configured = this.store.get().repository.directory;
    const candidates = [...new Set([
      configured,
      path.join(home, "Beep", "ds4"),
      path.join(home, "Beep", "ds4-glm52-gold"),
      path.join(home, "BEEP", "ds4")
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
