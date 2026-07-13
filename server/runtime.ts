import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { access, lstat, mkdir, open, readFile, readdir, rename, stat, statfs, writeFile } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import type { CatalogModel, DsboxConfig, LocalModelCandidate, LogEntry, RuntimeState } from "../src/types.js";
import { ConfigStore } from "./config.js";
import { EventBus } from "./event-bus.js";

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

export class TaskCancelledError extends Error {
  constructor() {
    super("Operazione annullata dall'utente");
    this.name = "TaskCancelledError";
  }
}

export function isTaskCancelledError(error: unknown): error is TaskCancelledError {
  return error instanceof Error && error.name === "TaskCancelledError";
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
  if (quote) throw new Error("Virgolette non chiuse nei flag avanzati");
  push();
  return result;
}

export function parseEnvironment(input: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Variabile ambiente non valida: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Nome variabile ambiente non valido: ${key}`);
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
  private taskCancelled = false;

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

  prepareOneClickStart(): void {
    if (this.engine || this.task || this.startPending || this.state.phase === "preparing") throw new Error("DSBox sta già lavorando");
    this.setState({
      phase: "preparing",
      readiness: "offline",
      currentTask: "Scelta automatica di modello e impostazioni",
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
      throw new Error(`Spazio insufficiente: servono circa ${requiredGb} GB liberi, disponibili ${freeGb} GB`);
    }
  }

  private async ensureAppleMetalToolchain(): Promise<void> {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("Questa versione di DSBox richiede macOS su Apple Silicon (arm64)");
    }
    try {
      await execFileAsync("xcrun", ["--find", "clang"], { timeout: 5000 });
    } catch {
      throw new Error("Toolchain Apple non trovato. Installa Xcode Command Line Tools con: xcode-select --install");
    }
  }

  private async ensurePortAvailable(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.unref();
      probe.once("error", () => reject(new Error(`La porta interna ${host}:${port} è già occupata`)));
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
    if (this.task || this.engine) throw new Error("Un'altra operazione DS4 è già in corso");
    this.taskCancelled = false;
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
      child.once("error", (error) => {
        this.task = null;
        const cancelled = this.taskCancelled;
        this.taskCancelled = false;
        reject(cancelled ? new TaskCancelledError() : error);
      });
      child.once("exit", (code, signal) => {
        this.task = null;
        const cancelled = this.taskCancelled;
        this.taskCancelled = false;
        if (cancelled) {
          reject(new TaskCancelledError());
          return;
        }
        if (code === 0) resolve();
        else reject(new Error(`${command} terminato con ${signal ? `segnale ${signal}` : `codice ${code ?? "?"}`}`));
      });
    });
  }

  async installOrUpdate(): Promise<void> {
    if (this.task || this.engine) throw new Error("Arresta il runtime prima di aggiornare");
    const config = this.store.get();
    const directory = config.repository.directory;
    const installed = await this.pathExists(path.join(directory, ".git"));
    this.setState({
      phase: installed ? "updating" : "installing",
      currentTask: installed ? "Aggiornamento fork" : "Clone della fork",
      lastError: null
    });
    try {
      await this.ensureAppleMetalToolchain();
      if (!installed) {
        const parent = path.dirname(directory);
        await mkdir(parent, { recursive: true });
        try {
          const existing = await lstat(directory);
          if (existing) throw new Error(`La cartella ${directory} esiste ma non è un checkout Git`);
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
          this.log("warn", "git", "Checkout con modifiche locali: sincronizzazione saltata, nessun file è stato sovrascritto.");
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
      this.log("success", "dsbox", "Engine Metal pronto.");
      this.setState({ phase: "idle", currentTask: null, lastError: null });
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.log("info", "dsbox", "Operazione interrotta. Nessun file parziale è stato eliminato.");
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
    if (this.task || this.engine) throw new Error("Arresta il runtime prima di compilare");
    const config = this.store.get();
    if (!(await this.pathExists(path.join(config.repository.directory, ".git")))) {
      throw new Error("Installa o seleziona prima un checkout ds4");
    }
    this.setState({ phase: "building", currentTask: "Build Metal", lastError: null });
    try {
      await this.ensureAppleMetalToolchain();
      await this.runTask("make", [`-j${Math.max(2, Math.min(cpus().length, 12))}`, "ds4-server"], config.repository.directory, "build");
      await this.recordBuildHead(config.repository.directory);
      this.log("success", "dsbox", "Build Metal completata.");
      this.setState({ phase: "idle", currentTask: null });
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.log("info", "dsbox", "Operazione interrotta.");
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
    if (!allowed.has(variant)) throw new Error("Variante modello non supportata dal launcher");
    if (this.task || this.engine) throw new Error("Arresta il runtime prima di scaricare il modello");
    const config = this.store.get();
    const script = path.join(config.repository.directory, "download_model.sh");
    if (!(await this.pathExists(script))) throw new Error("download_model.sh non trovato: installa prima la fork");
    const estimatedBytes = estimatedSizesGb[variant] * 1024 ** 3;
    const downloadedBytes = await this.fallbackDownloadedBytes(script, variant, config.repository.directory, estimatedBytes);
    await this.ensureDiskSpace(config.repository.directory, remainingDownloadBytes(estimatedBytes, downloadedBytes));
    if (downloadedBytes > 0 && downloadedBytes < estimatedBytes) {
      this.log("info", "download", `Ripresa del download: ${Math.floor(downloadedBytes / 1024 ** 3)} GB già presenti.`);
    }
    this.setState({ phase: "downloading", currentTask: `Download ${variant}`, lastError: null });
    try {
      await this.runTask("/bin/zsh", [script, variant], config.repository.directory, "download");
      this.log("success", "dsbox", "Download completato e collegamento ds4flash.gguf aggiornato.");
      this.setState({ phase: "idle", currentTask: null });
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.log("info", "dsbox", "Download interrotto. Potrai riprenderlo in seguito.");
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
      if (model.recommended) throw new Error("Il manifest del modello non dichiara una versione verificabile del motore DS4");
      return;
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(model.runtimeCommit)) {
      throw new Error("Commit DS4 richiesto dal modello non valido");
    }

    let config = this.store.get();
    const gitDirectory = path.join(config.repository.directory, ".git");
    if (!(await this.pathExists(gitDirectory))) {
      this.log("info", "dsbox", "Preparo il motore richiesto dal modello prima del download.");
      await this.installOrUpdate();
      config = this.store.get();
    }
    const sourceCompatible = await this.runtimeIncludesCommit(config.repository.directory, model.runtimeCommit);
    if (sourceCompatible && await this.buildMatchesHead(config.repository.directory)) return;

    const dirty = await execFileAsync("git", ["status", "--porcelain"], { cwd: config.repository.directory })
      .then((result) => Boolean(result.stdout.trim()))
      .catch(() => true);
    if (dirty) {
      throw new Error("Il checkout DS4 contiene modifiche locali e non può essere verificato o ricompilato automaticamente per questo modello");
    }

    if (sourceCompatible) {
      this.log("info", "build", "Ricompilo DS4 per associare il binario al commit verificato dal modello.");
      await this.build();
      if (!(await this.buildMatchesHead(config.repository.directory))) {
        throw new Error("Il binario DS4 non corrisponde al commit verificato dal modello");
      }
      return;
    }

    this.log("info", "git", `Aggiorno DS4 al requisito del modello (${model.runtimeCommit.slice(0, 9)}).`);
    await this.installOrUpdate();
    if (!(await this.runtimeIncludesCommit(config.repository.directory, model.runtimeCommit))) {
      throw new Error(`Il canale ${model.runtimeBranch ?? config.repository.branch} non contiene il commit DS4 richiesto dal modello`);
    }
    if (!(await this.buildMatchesHead(config.repository.directory))) {
      throw new Error("Il motore aggiornato non ha prodotto un binario associato al commit Git corrente");
    }
    this.log("success", "git", "Motore DS4 aggiornato e ricompilato per il modello selezionato.");
  }

  async downloadCatalogModel(model: CatalogModel): Promise<void> {
    if (!model.repository.startsWith("andreaborio/")) throw new Error("Il catalogo accetta solo modelli dalla sorgente Hugging Face configurata");
    if (!model.installable || !model.outputFile || model.files.length !== 1) {
      throw new Error(model.unavailableReason || "Questo modello non supporta ancora l'installazione automatica");
    }
    if (this.task || this.engine) throw new Error("Spegni DS4 prima di cambiare modello");
    if (!/^[a-f0-9]{40,64}$/i.test(model.revision)) throw new Error("Revisione Hugging Face non valida");
    const config = this.store.get();
    if (model.runtimeBranch && model.runtimeBranch !== config.repository.branch) {
      throw new Error(`Questo modello richiede il canale ${model.runtimeBranch}`);
    }
    if (model.runtimeBranch && await this.pathExists(path.join(config.repository.directory, ".git"))) {
      const actualBranch = await execFileAsync("git", ["branch", "--show-current"], { cwd: config.repository.directory })
        .then((result) => result.stdout.trim())
        .catch(() => "");
      if (actualBranch && actualBranch !== model.runtimeBranch) {
        throw new Error(`Il motore installato usa il canale ${actualBranch}; questo modello richiede ${model.runtimeBranch}`);
      }
    }
    await this.ensureCatalogRuntime(model);
    const filename = path.basename(model.outputFile);
    if (!filename.toLowerCase().endsWith(".gguf")) throw new Error("Il file selezionato non è un GGUF");
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
        this.log("success", "dsbox", `${model.label} è già disponibile sul Mac.`);
        await this.refresh();
        return;
      }
      this.log("warn", "download", "Il file locale non corrisponde alla revisione del catalogo; verrà riscaricato.");
    } catch {
      // Download or resume below.
    }

    this.setState({ phase: "downloading", currentTask: `Download di ${model.label}`, lastError: null });
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
        throw new Error(`Download incompleto: ${completed.size} byte ricevuti, ${expectedBytes} attesi`);
      }
      if (expectedSha256) {
        const actualSha256 = await this.sha256(partial);
        if (actualSha256 !== expectedSha256) {
          await rename(partial, `${partial}.corrupt-${Date.now()}`);
          throw new Error("Checksum SHA-256 del modello non valido; il file incompleto è stato isolato");
        }
      }
      await rename(partial, destination);
      const next = this.store.get();
      next.model.path = destination;
      next.model.id = model.modelId;
      const saved = await this.store.set(next);
      this.bus.publish({ type: "config", payload: saved });
      this.log("success", "dsbox", `${model.label} è pronto.`);
      this.setState({ phase: "idle", currentTask: null, lastError: null });
    } catch (error) {
      if (isTaskCancelledError(error)) {
        this.log("info", "dsbox", "Download interrotto. Il file parziale resta disponibile per la ripresa.");
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
    return filename.slice(0, 160) || "modello-locale";
  }

  private async inspectLocalModel(filePath: string, selectedPath: string): Promise<LocalModelCandidate | null> {
    const absolutePath = path.resolve(filePath);
    if (!absolutePath.toLowerCase().endsWith(".gguf")) return null;
    try {
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size < 8) return null;
      const handle = await open(absolutePath, "r");
      const magic = Buffer.alloc(4);
      try {
        await handle.read(magic, 0, magic.length, 0);
      } finally {
        await handle.close();
      }
      if (magic.toString("ascii") !== "GGUF") return null;
      return {
        path: absolutePath,
        name: path.basename(absolutePath, ".gguf"),
        sizeBytes: info.size,
        modelId: this.inferLocalModelId(absolutePath),
        selected: absolutePath === path.resolve(selectedPath)
      };
    } catch {
      return null;
    }
  }

  async discoverLocalModels(): Promise<LocalModelCandidate[]> {
    const config = this.store.get();
    const userHome = path.dirname(this.store.homeDirectory);
    const rawRoots = [
      path.dirname(config.model.path),
      path.join(this.store.homeDirectory, "models"),
      path.join(userHome, "Downloads"),
      path.join(userHome, "Documents"),
      path.join(userHome, "Beep")
    ].map((root) => path.resolve(root));
    const roots = [...new Set(rawRoots)]
      .sort((left, right) => left.length - right.length)
      .filter((root, index, all) => !all.slice(0, index).some((parent) => root.startsWith(`${parent}${path.sep}`)));
    const candidates: LocalModelCandidate[] = [];
    const seen = new Set<string>();
    const skippedDirectories = new Set([".git", "node_modules", "dist", "dist-server", "build", ".cache"]);

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 6 || candidates.length >= 120) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (candidates.length >= 120) break;
        const candidatePath = path.join(directory, entry.name);
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

  async selectLocalModel(filePath: string, modelId?: string): Promise<LocalModelCandidate> {
    if (this.task || this.engine) throw new Error("Interrompi il download o spegni DSBox prima di cambiare modello");
    if (!path.isAbsolute(filePath)) throw new Error("Inserisci il percorso completo del file GGUF");
    const candidate = await this.inspectLocalModel(filePath, filePath);
    if (!candidate) throw new Error("Questo file non esiste o non è un GGUF leggibile");
    const next = this.store.get();
    next.model.path = candidate.path;
    next.model.id = modelId?.trim() || candidate.modelId;
    const saved = await this.store.set(next);
    this.bus.publish({ type: "config", payload: saved });
    this.log("success", "dsbox", `${candidate.name} selezionato dal Mac. Nessun download necessario.`);
    this.setState({ phase: this.state.installed ? "idle" : "uninstalled", currentTask: null, lastError: null, readiness: "offline" });
    await this.refresh();
    return { ...candidate, modelId: saved.model.id, selected: true };
  }

  cancelTask(): void {
    if (!this.task) throw new Error("Nessuna operazione annullabile in corso");
    this.log("warn", "dsbox", "Interruzione richiesta. I download supportano la ripresa al prossimo avvio.");
    this.taskCancelled = true;
    this.setState({ currentTask: "Interruzione in corso" });
    const pid = this.task.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        // Fall back to signaling the direct child.
      }
    }
    this.task.kill("SIGTERM");
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
      throw new Error("Impossibile leggere le capability di ds4-server");
    }
  }

  private validateCapabilities(args: string[], help: string): void {
    const unsupported = [...new Set(args.filter(isOptionToken).map(optionName))]
      .filter((option) => !["-m", "-c", "-n", "-t"].includes(option))
      .filter((option) => !help.includes(option));
    if (unsupported.length) {
      throw new Error(`Flag non supportati dal checkout selezionato: ${unsupported.join(", ")}`);
    }
  }

  async start(): Promise<void> {
    if (this.engine || this.task || this.startPending) throw new Error("Un processo o un'operazione DS4 è già attiva");
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
    if (!(await this.pathExists(binary, true))) throw new Error("ds4-server non compilato");
    let modelStat;
    try {
      modelStat = await stat(config.model.path);
    } catch {
      throw new Error("Il modello GGUF selezionato non esiste");
    }
    if (!modelStat.isFile()) throw new Error("Il percorso modello non indica un file GGUF");

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
      currentTask: "Caricamento modello e Metal graph",
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
      const message = normal ? null : `ds4-server terminato con ${signal ? `segnale ${signal}` : `codice ${code ?? "?"}`}`;
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
          this.log("info", "dsbox", `Modello esposto dal runtime: ${modelId}`);
        }
        this.log("success", "dsbox", "ds4-server pronto per chat e coding agent.");
        this.setState({ phase: "running", readiness: "ready", currentTask: null });
        if (this.readinessTimer) clearInterval(this.readinessTimer);
        this.readinessTimer = null;
      } catch {
        // Model loading can legitimately take several minutes.
      }
    }, 1000);
  }

  async stop(): Promise<void> {
    if (!this.engine) throw new Error("ds4-server non è in esecuzione");
    if (this.readinessTimer) clearInterval(this.readinessTimer);
    this.readinessTimer = null;
    this.stopping = true;
    this.setState({ phase: "stopping", currentTask: "Salvataggio KV e arresto" });
    this.log("info", "dsbox", "Invio SIGTERM: ds4 può completare la richiesta attiva e salvare la cache KV.");
    const child = this.engine;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.log("warn", "dsbox", "Il runtime sta ancora completando lo shutdown; nessun force-kill automatico è stato eseguito.");
        resolve();
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async forceStop(): Promise<void> {
    if (!this.engine) throw new Error("ds4-server non è in esecuzione");
    this.log("warn", "dsbox", "Force stop richiesto; l'ultimo checkpoint KV potrebbe non essere salvato.");
    this.stopping = true;
    this.engine.kill("SIGKILL");
  }

  async restart(): Promise<void> {
    if (this.engine) await this.stop();
    if (this.engine) throw new Error("Il processo precedente non si è ancora arrestato");
    await this.start();
  }

  async oneClickStart(recommendedModel: CatalogModel | null = null): Promise<void> {
    if (this.engine || this.task) throw new Error("DS4 è già occupato da un'altra operazione");
    try {
      let state = await this.refresh();
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

      if (!state.modelPresent) {
        throw new Error("Nessun modello pronto. Scegli un file GGUF già presente sul Mac oppure avvia esplicitamente un download dal catalogo DSBox.");
      }

      if (!state.built || !state.modelPresent) {
        throw new Error("La preparazione automatica non ha completato motore e modello");
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
