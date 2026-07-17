import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  truncate,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  CatalogModel,
  CatalogModelAssembly,
  CatalogModelFile,
  CatalogModelVariant,
  Ds4ArtifactFormat,
  ModelDownloadFileSnapshot,
  ModelDownloadSnapshot
} from "../src/types.js";
import { ConfigStore } from "./config.js";
import { EventBus } from "./event-bus.js";

const stateVersion = 1;
const progressBroadcastIntervalMs = 250;
const progressPersistIntervalMs = 1_000;
const speedWindowMs = 8_000;

interface DownloadRecord {
  version: typeof stateVersion;
  snapshot: ModelDownloadSnapshot;
  assembly: CatalogModelAssembly | null;
  stagingDirectory: string;
}

interface ActiveDownload {
  controller: AbortController;
  promise: Promise<void>;
  cancelRequested: boolean;
  removePartials: boolean;
  samples: Array<{ at: number; bytes: number }>;
  lastBroadcastAt: number;
  lastPersistAt: number;
}

export interface ModelDownloadManagerOptions {
  fetch?: typeof globalThis.fetch;
  hubBaseUrl?: string;
  getDiskFreeBytes?: (target: string) => Promise<number>;
  canStart?: () => boolean;
  validateReadyModel?: (
    modelPath: string,
    modelId: string,
    expectedArtifactFormat?: Ds4ArtifactFormat | null
  ) => Promise<void>;
  onReady?: (modelPath: string, modelId: string) => Promise<void>;
  retryDelayMs?: number;
}

export class ModelDownloadError extends Error {
  readonly status: 400 | 404 | 409 | 507;

  constructor(message: string, status: 400 | 404 | 409 | 507 = 400) {
    super(message);
    this.name = "ModelDownloadError";
    this.status = status;
  }
}

function cloneSnapshot(snapshot: ModelDownloadSnapshot): ModelDownloadSnapshot {
  return structuredClone(snapshot);
}

function safeRepository(repository: string): [string, string] {
  const match = repository.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match) throw new ModelDownloadError("Invalid Hugging Face repository");
  return [match[1], match[2]];
}

function safeRevision(revision: string): string {
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new ModelDownloadError("Invalid pinned Hugging Face revision");
  return revision.toLowerCase();
}

function safeRelativeFile(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new ModelDownloadError("The catalog contains an invalid model filename");
  }
  const clean = path.posix.normalize(normalized);
  if (clean === "." || clean === ".." || clean.startsWith("../")) {
    throw new ModelDownloadError("The catalog contains an unsafe model filename");
  }
  return clean;
}

function normalizedSha256(value: string | null): string | null {
  const normalized = value?.trim().replace(/^sha256:/i, "").replace(/^"|"$/g, "").toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TaskCancelledError");
}

function firstShard(files: CatalogModelFile[]): CatalogModelFile | undefined {
  return files.find((file) => /-00001-of-\d{5}\.gguf$/i.test(file.name)) ?? files[0];
}

function selectedVariant(model: CatalogModel, requestedVariantId?: string): CatalogModelVariant {
  if (requestedVariantId) {
    const variant = model.variants.find((candidate) => candidate.id === requestedVariantId);
    if (!variant) throw new ModelDownloadError("This quantization is not part of the pinned catalog revision", 404);
    if (!variant.installable) throw new ModelDownloadError(variant.unavailableReason || "This quantization cannot be installed automatically", 409);
    return variant;
  }

  if (model.outputFile && model.files.length) {
    const matching = model.variants.find((variant) => variant.outputFile === model.outputFile
      && variant.files.length === model.files.length
      && variant.files.every((file, index) => file.name === model.files[index]?.name));
    if (matching?.installable) return matching;
    return {
      id: createHash("sha256").update(model.files.map((file) => file.name).join("|")).digest("hex").slice(0, 16),
      label: model.label,
      files: model.files,
      outputFile: model.outputFile,
      totalBytes: model.totalBytes,
      installable: true,
      unavailableReason: null,
      assembly: null
    };
  }

  const installable = model.variants.filter((variant) => variant.installable);
  if (installable.length === 1) return installable[0];
  if (installable.length > 1) {
    throw new ModelDownloadError("Choose a quantization in DSBox before starting the download", 409);
  }
  throw new ModelDownloadError(model.unavailableReason || "No complete installable GGUF bundle was found", 409);
}

function downloadId(model: CatalogModel, variant: CatalogModelVariant): string {
  return createHash("sha256")
    .update(`${model.repository}@${model.revision}:${variant.id}:${variant.files.map((file) => file.name).join("|")}`)
    .digest("hex")
    .slice(0, 20);
}

async function pathSize(target: string): Promise<number> {
  try {
    const value = await stat(target);
    return value.isFile() ? value.size : 0;
  } catch {
    return 0;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(target: string, start = 0, length?: number): Promise<string> {
  const hash = createHash("sha256");
  const options = length === undefined ? undefined : { start, end: start + length - 1 };
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target, options);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function fileUrl(baseUrl: string, repository: string, revision: string, filename: string): string {
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  const encodedFilename = filename.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}/${encodedRepository}/resolve/${encodeURIComponent(revision)}/${encodedFilename}?download=true`;
}

export class ModelDownloadManager {
  private readonly store: ConfigStore;
  private readonly bus: EventBus;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly hubBaseUrl: string;
  private readonly getDiskFreeBytes: (target: string) => Promise<number>;
  private readonly canStart: () => boolean;
  private readonly validateReadyModel: ((
    modelPath: string,
    modelId: string,
    expectedArtifactFormat?: Ds4ArtifactFormat | null
  ) => Promise<void>) | null;
  private readonly onReady: ((modelPath: string, modelId: string) => Promise<void>) | null;
  private readonly retryDelayMs: number;
  private readonly stateDirectory: string;
  private readonly statePath: string;
  private readonly records = new Map<string, DownloadRecord>();
  private readonly active = new Map<string, ActiveDownload>();
  private persistQueue: Promise<void> = Promise.resolve();

  private constructor(store: ConfigStore, bus: EventBus, options: ModelDownloadManagerOptions) {
    this.store = store;
    this.bus = bus;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.hubBaseUrl = (options.hubBaseUrl ?? "https://huggingface.co").replace(/\/$/, "");
    this.getDiskFreeBytes = options.getDiskFreeBytes ?? (async (target) => {
      const filesystem = await statfs(target);
      return Number(filesystem.bavail) * Number(filesystem.bsize);
    });
    this.canStart = options.canStart ?? (() => true);
    this.validateReadyModel = options.validateReadyModel ?? null;
    this.onReady = options.onReady ?? null;
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
    this.stateDirectory = path.join(store.homeDirectory, "downloads");
    this.statePath = path.join(this.stateDirectory, "state.json");
  }

  static async open(
    store: ConfigStore,
    bus: EventBus,
    options: ModelDownloadManagerOptions = {}
  ): Promise<ModelDownloadManager> {
    const manager = new ModelDownloadManager(store, bus, options);
    await mkdir(manager.stateDirectory, { recursive: true, mode: 0o700 });
    await manager.restore();
    return manager;
  }

  private async restore(): Promise<void> {
    try {
      const payload = JSON.parse(await readFile(this.statePath, "utf8")) as { version?: number; downloads?: DownloadRecord[] };
      if (payload.version !== stateVersion || !Array.isArray(payload.downloads)) return;
      for (const candidate of payload.downloads) {
        if (candidate?.version !== stateVersion || !candidate.snapshot?.id || !candidate.stagingDirectory) continue;
        const record = structuredClone(candidate);
        if (["queued", "preflighting", "downloading", "verifying"].includes(record.snapshot.stage)) {
          record.snapshot.stage = "paused";
          record.snapshot.error = "DSBox closed before the download completed. Resume to continue.";
          record.snapshot.speedBytesPerSecond = 0;
          record.snapshot.etaSeconds = null;
          record.snapshot.completedAt = null;
        }
        this.records.set(record.snapshot.id, record);
        await this.reconcileProgress(record);
      }
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await rename(this.statePath, `${this.statePath}.invalid-${Date.now()}`).catch(() => undefined);
      }
    }
  }

  list(): ModelDownloadSnapshot[] {
    return [...this.records.values()]
      .map((record) => cloneSnapshot(record.snapshot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): ModelDownloadSnapshot {
    const record = this.records.get(id);
    if (!record) throw new ModelDownloadError("Download not found", 404);
    return cloneSnapshot(record.snapshot);
  }

  hasActive(): boolean {
    return this.active.size > 0;
  }

  private async persist(): Promise<void> {
    const payload = {
      version: stateVersion,
      downloads: [...this.records.values()]
    };
    const temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    this.persistQueue = this.persistQueue.then(async () => {
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.statePath);
    });
    await this.persistQueue;
  }

  private publish(record: DownloadRecord, persist = false): void {
    record.snapshot.updatedAt = new Date().toISOString();
    this.bus.publish({ type: "download", payload: cloneSnapshot(record.snapshot) });
    if (persist) void this.persist().catch(() => undefined);
  }

  private createActive(record: DownloadRecord): ActiveDownload {
    const controller = new AbortController();
    const active: ActiveDownload = {
      controller,
      promise: Promise.resolve(),
      cancelRequested: false,
      removePartials: false,
      samples: [{ at: Date.now(), bytes: record.snapshot.downloadedBytes }],
      lastBroadcastAt: 0,
      lastPersistAt: 0
    };
    active.promise = this.run(record, active).finally(() => {
      if (this.active.get(record.snapshot.id) === active) this.active.delete(record.snapshot.id);
    });
    this.active.set(record.snapshot.id, active);
    return active;
  }

  async start(model: CatalogModel, requestedVariantId?: string): Promise<ModelDownloadSnapshot> {
    if (this.active.size) throw new ModelDownloadError("Another model download is already running", 409);
    if (!this.canStart()) throw new ModelDownloadError("Turn off DS4 and wait for its current operation before downloading a model", 409);
    const [owner, repositoryName] = safeRepository(model.repository);
    const revision = safeRevision(model.revision);
    const variant = selectedVariant(model, requestedVariantId);
    if (!variant.files.length) throw new ModelDownloadError("The selected quantization has no downloadable files", 409);
    for (const file of variant.files) safeRelativeFile(file.name);
    const outputFile = safeRelativeFile(variant.outputFile || firstShard(variant.files)?.name || "");
    const id = downloadId(model, variant);
    const current = this.records.get(id);
    if (current?.snapshot.stage === "ready") return cloneSnapshot(current.snapshot);
    if (current) return this.resume(id);

    const destinationDirectory = path.join(
      this.store.homeDirectory,
      "models",
      repositoryName,
      revision,
      `bundle-${variant.id}`
    );
    const now = new Date().toISOString();
    const files: ModelDownloadFileSnapshot[] = variant.files.map((file) => ({
      name: safeRelativeFile(file.name),
      sizeBytes: Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0 ? file.sizeBytes : 0,
      sha256: normalizedSha256(file.sha256),
      downloadedBytes: 0,
      stage: "pending"
    }));
    const record: DownloadRecord = {
      version: stateVersion,
      assembly: variant.assembly,
      stagingDirectory: `${destinationDirectory}.partial`,
      snapshot: {
        id,
        repository: `${owner}/${repositoryName}`,
        revision,
        variantId: variant.id,
        variantLabel: variant.label,
        modelId: model.modelId,
        artifactFormat: model.artifactFormat ?? null,
        label: model.label,
        stage: "queued",
        files,
        outputFile,
        totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        downloadedBytes: 0,
        speedBytesPerSecond: 0,
        etaSeconds: null,
        destinationDirectory,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        error: null,
        disk: { availableBytes: null, requiredBytes: 0, shortfallBytes: 0 }
      }
    };
    this.records.set(id, record);
    await this.persist();
    this.publish(record);
    this.createActive(record);
    return cloneSnapshot(record.snapshot);
  }

  async resume(id: string): Promise<ModelDownloadSnapshot> {
    const record = this.records.get(id);
    if (!record) throw new ModelDownloadError("Download not found", 404);
    if (record.snapshot.stage === "ready") return cloneSnapshot(record.snapshot);
    if (this.active.has(id)) return cloneSnapshot(record.snapshot);
    if (this.active.size) throw new ModelDownloadError("Another model download is already running", 409);
    if (!this.canStart()) throw new ModelDownloadError("Turn off DS4 and wait for its current operation before resuming the download", 409);
    await this.reconcileProgress(record);
    record.snapshot.stage = "queued";
    record.snapshot.error = null;
    record.snapshot.completedAt = null;
    record.snapshot.speedBytesPerSecond = 0;
    record.snapshot.etaSeconds = null;
    await this.persist();
    this.publish(record);
    this.createActive(record);
    return cloneSnapshot(record.snapshot);
  }

  async cancel(id: string, removePartials = false): Promise<ModelDownloadSnapshot> {
    const record = this.records.get(id);
    if (!record) throw new ModelDownloadError("Download not found", 404);
    const active = this.active.get(id);
    if (active) {
      active.cancelRequested = true;
      active.removePartials = removePartials;
      active.controller.abort();
      await active.promise;
      const requestedStage = removePartials ? "cancelled" : "paused";
      if (record.snapshot.stage === "ready" || record.snapshot.stage === requestedStage) {
        return cloneSnapshot(record.snapshot);
      }
    }
    if (record.snapshot.stage === "ready") return cloneSnapshot(record.snapshot);
    if (removePartials) {
      await rm(record.stagingDirectory, { recursive: true, force: true });
      for (const file of record.snapshot.files) {
        file.downloadedBytes = 0;
        file.stage = "pending";
      }
      record.snapshot.downloadedBytes = 0;
      record.snapshot.stage = "cancelled";
      record.snapshot.error = null;
    } else {
      await this.reconcileProgress(record);
      record.snapshot.stage = "paused";
      record.snapshot.error = null;
    }
    record.snapshot.speedBytesPerSecond = 0;
    record.snapshot.etaSeconds = null;
    await this.persist();
    this.publish(record);
    return cloneSnapshot(record.snapshot);
  }

  private async run(record: DownloadRecord, active: ActiveDownload): Promise<void> {
    try {
      await mkdir(record.stagingDirectory, { recursive: true, mode: 0o700 });
      record.snapshot.stage = "preflighting";
      record.snapshot.error = null;
      this.publish(record, true);
      await this.completeMissingMetadata(record, active.controller.signal);
      await this.reconcileProgress(record);
      if (await this.destinationValid(record)) {
        await rm(record.stagingDirectory, { recursive: true, force: true });
        await this.markReady(record);
        return;
      }
      await this.preflightDisk(record);
      record.snapshot.stage = "downloading";
      this.publish(record, true);

      if (record.assembly?.type === "concatenate") {
        await this.downloadAssembly(record, active);
      } else {
        await this.downloadFiles(record, active);
      }
      active.controller.signal.throwIfAborted();
      await this.commit(record);
      await this.markReady(record);
    } catch (error) {
      if (active.cancelRequested || isAbortError(error)) {
        if (active.removePartials) {
          await rm(record.stagingDirectory, { recursive: true, force: true });
          for (const file of record.snapshot.files) {
            file.downloadedBytes = 0;
            file.stage = "pending";
          }
          record.snapshot.downloadedBytes = 0;
          record.snapshot.stage = "cancelled";
        } else {
          await this.reconcileProgress(record);
          record.snapshot.stage = "paused";
        }
        record.snapshot.error = null;
      } else {
        await this.reconcileProgress(record);
        record.snapshot.stage = "error";
        record.snapshot.error = error instanceof Error ? error.message : String(error);
      }
      record.snapshot.speedBytesPerSecond = 0;
      record.snapshot.etaSeconds = null;
      await this.persist();
      this.publish(record);
    }
  }

  private requestHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers({
      "user-agent": "DSBox/0.1 (+local-model-download)",
      ...extra
    });
    const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  private async completeMissingMetadata(record: DownloadRecord, signal: AbortSignal): Promise<void> {
    for (const file of record.snapshot.files) {
      if (file.sizeBytes > 0 && file.sha256) continue;
      const response = await this.fetcher(
        fileUrl(this.hubBaseUrl, record.snapshot.repository, record.snapshot.revision, file.name),
        { method: "HEAD", headers: this.requestHeaders(), redirect: "follow", signal }
      );
      if (!response.ok) throw this.httpError(response, file.name);
      const linkedSize = Number(response.headers.get("x-linked-size"));
      const contentLength = Number(response.headers.get("content-length"));
      const size = Number.isSafeInteger(linkedSize) && linkedSize > 0 ? linkedSize : contentLength;
      if (!file.sizeBytes && Number.isSafeInteger(size) && size > 0) file.sizeBytes = size;
      const linkedEtag = normalizedSha256(response.headers.get("x-linked-etag"));
      if (!file.sha256 && linkedEtag) file.sha256 = linkedEtag;
      if (!file.sizeBytes) throw new ModelDownloadError(`Hugging Face did not report the size of ${file.name}`, 409);
    }
    record.snapshot.totalBytes = record.snapshot.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    await this.persist();
  }

  private async preflightDisk(record: DownloadRecord): Promise<void> {
    await mkdir(path.dirname(record.snapshot.destinationDirectory), { recursive: true, mode: 0o700 });
    const availableBytes = await this.getDiskFreeBytes(path.dirname(record.snapshot.destinationDirectory));
    const missingBytes = Math.max(0, record.snapshot.totalBytes - record.snapshot.downloadedBytes);
    const reserveBytes = Math.min(8 * 1024 ** 3, Math.max(512 * 1024 ** 2, Math.ceil(record.snapshot.totalBytes * 0.02)));
    const requiredBytes = missingBytes + reserveBytes;
    const shortfallBytes = Math.max(0, requiredBytes - availableBytes);
    record.snapshot.disk = { availableBytes, requiredBytes, shortfallBytes };
    this.publish(record, true);
    if (shortfallBytes > 0) {
      throw new ModelDownloadError(
        `Not enough free space for this download. Free at least ${Math.ceil(shortfallBytes / 1024 ** 3)} GB and resume.`,
        507
      );
    }
  }

  private async reconcileProgress(record: DownloadRecord): Promise<void> {
    let downloaded = 0;
    if (record.assembly?.type === "concatenate") {
      const output = path.join(record.stagingDirectory, ...safeRelativeFile(record.snapshot.outputFile).split("/"));
      const outputBytes = Math.min(record.snapshot.totalBytes || Number.MAX_SAFE_INTEGER, Math.max(
        await pathSize(`${output}.part`),
        await pathSize(output)
      ));
      let remaining = outputBytes;
      for (const file of record.snapshot.files) {
        file.downloadedBytes = Math.min(file.sizeBytes, Math.max(0, remaining));
        file.stage = file.downloadedBytes === file.sizeBytes ? "complete" : file.downloadedBytes > 0 ? "downloading" : "pending";
        remaining -= file.downloadedBytes;
        downloaded += file.downloadedBytes;
      }
    } else {
      for (const file of record.snapshot.files) {
        const relative = safeRelativeFile(file.name);
        const staged = path.join(record.stagingDirectory, ...relative.split("/"));
        const finalBytes = await pathSize(staged);
        const partialBytes = await pathSize(`${staged}.part`);
        file.downloadedBytes = Math.min(file.sizeBytes || Number.MAX_SAFE_INTEGER, Math.max(finalBytes, partialBytes));
        file.stage = file.sizeBytes > 0 && file.downloadedBytes === file.sizeBytes ? "complete" : file.downloadedBytes > 0 ? "downloading" : "pending";
        downloaded += file.downloadedBytes;
      }
    }
    record.snapshot.downloadedBytes = Math.min(record.snapshot.totalBytes || Number.MAX_SAFE_INTEGER, downloaded);
  }

  private progress(record: DownloadRecord, active: ActiveDownload, force = false): void {
    record.snapshot.downloadedBytes = record.snapshot.files.reduce((sum, file) => sum + file.downloadedBytes, 0);
    const now = Date.now();
    active.samples.push({ at: now, bytes: record.snapshot.downloadedBytes });
    active.samples = active.samples.filter((sample) => now - sample.at <= speedWindowMs);
    const first = active.samples[0];
    const elapsedSeconds = first ? Math.max(0.001, (now - first.at) / 1000) : 0;
    const speed = first && elapsedSeconds > 0
      ? Math.max(0, (record.snapshot.downloadedBytes - first.bytes) / elapsedSeconds)
      : 0;
    record.snapshot.speedBytesPerSecond = Math.round(speed);
    record.snapshot.etaSeconds = speed > 0
      ? Math.max(0, Math.ceil((record.snapshot.totalBytes - record.snapshot.downloadedBytes) / speed))
      : null;
    if (force || now - active.lastBroadcastAt >= progressBroadcastIntervalMs) {
      active.lastBroadcastAt = now;
      const shouldPersist = force || now - active.lastPersistAt >= progressPersistIntervalMs;
      if (shouldPersist) active.lastPersistAt = now;
      this.publish(record, shouldPersist);
    }
  }

  private async downloadFiles(record: DownloadRecord, active: ActiveDownload): Promise<void> {
    for (const file of record.snapshot.files) {
      active.controller.signal.throwIfAborted();
      const relative = safeRelativeFile(file.name);
      const staged = path.join(record.stagingDirectory, ...relative.split("/"));
      const partial = `${staged}.part`;
      await mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
      if (await pathExists(staged)) {
        const valid = await this.verifyFile(staged, file);
        if (valid) {
          file.downloadedBytes = file.sizeBytes;
          file.stage = "complete";
          this.progress(record, active, true);
          continue;
        }
        await rm(staged, { force: true });
      }
      const existing = await pathSize(partial);
      if (file.sizeBytes && existing > file.sizeBytes) await truncate(partial, 0);
      file.downloadedBytes = Math.min(existing, file.sizeBytes);
      file.stage = "downloading";
      await this.downloadRemote(record, file, partial, file.downloadedBytes, active, (bytes) => {
        file.downloadedBytes += bytes;
        this.progress(record, active);
      });
      file.stage = "verifying";
      record.snapshot.stage = "verifying";
      this.progress(record, active, true);
      if (!(await this.verifyFile(partial, file))) {
        file.stage = "error";
        await rename(partial, `${partial}.corrupt-${Date.now()}`).catch(() => undefined);
        throw new Error(`Checksum or size verification failed for ${file.name}`);
      }
      await rename(partial, staged);
      file.downloadedBytes = file.sizeBytes;
      file.stage = "complete";
      record.snapshot.stage = "downloading";
      this.progress(record, active, true);
    }
  }

  private async downloadAssembly(record: DownloadRecord, active: ActiveDownload): Promise<void> {
    const output = path.join(record.stagingDirectory, ...safeRelativeFile(record.snapshot.outputFile).split("/"));
    const partial = `${output}.part`;
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    if (await pathExists(output) && await pathSize(output) === record.snapshot.totalBytes) return;
    let assembledBytes = await pathSize(partial);
    if (assembledBytes > record.snapshot.totalBytes) {
      await truncate(partial, 0);
      assembledBytes = 0;
    }
    let partStart = 0;
    for (const file of record.snapshot.files) {
      active.controller.signal.throwIfAborted();
      let offset = Math.max(0, Math.min(file.sizeBytes, assembledBytes - partStart));
      if (offset === file.sizeBytes && file.sha256) {
        const checksum = await fileSha256(partial, partStart, file.sizeBytes);
        if (checksum !== file.sha256) {
          await truncate(partial, partStart);
          assembledBytes = partStart;
          offset = 0;
        }
      }
      file.downloadedBytes = offset;
      if (offset < file.sizeBytes) {
        file.stage = "downloading";
        await this.downloadRemote(record, file, partial, offset, active, (bytes) => {
          file.downloadedBytes += bytes;
          assembledBytes += bytes;
          this.progress(record, active);
        });
      }
      file.stage = "verifying";
      record.snapshot.stage = "verifying";
      this.progress(record, active, true);
      if (await pathSize(partial) !== partStart + file.sizeBytes) {
        throw new Error(`Incomplete model part: ${file.name}`);
      }
      if (file.sha256 && await fileSha256(partial, partStart, file.sizeBytes) !== file.sha256) {
        await truncate(partial, partStart);
        file.downloadedBytes = 0;
        file.stage = "error";
        throw new Error(`Checksum verification failed for ${file.name}`);
      }
      file.downloadedBytes = file.sizeBytes;
      file.stage = "complete";
      partStart += file.sizeBytes;
      record.snapshot.stage = "downloading";
      this.progress(record, active, true);
    }
    if (await pathSize(partial) !== record.snapshot.totalBytes) throw new Error("The assembled GGUF has an unexpected size");
    await rename(partial, output);
  }

  private async downloadRemote(
    record: DownloadRecord,
    file: ModelDownloadFileSnapshot,
    target: string,
    initialOffset: number,
    active: ActiveDownload,
    onBytes: (bytes: number) => void
  ): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      active.controller.signal.throwIfAborted();
      let offset = attempt === 0 ? initialOffset : await pathSize(target);
      if (record.assembly?.type === "concatenate") {
        const precedingBytes = record.snapshot.files.slice(0, record.snapshot.files.indexOf(file))
          .reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
        offset = Math.max(0, (await pathSize(target)) - precedingBytes);
      }
      try {
        await this.fetchToFile(record, file, target, offset, active.controller.signal, onBytes);
        return;
      } catch (error) {
        if (isAbortError(error) || active.controller.signal.aborted) throw error;
        lastError = error;
        if (attempt === 3) break;
        await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Download failed for ${file.name}`);
  }

  private async fetchToFile(
    record: DownloadRecord,
    file: ModelDownloadFileSnapshot,
    target: string,
    requestedOffset: number,
    signal: AbortSignal,
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const url = fileUrl(this.hubBaseUrl, record.snapshot.repository, record.snapshot.revision, file.name);
    let offset = Math.max(0, requestedOffset);
    let response = await this.fetcher(url, {
      headers: this.requestHeaders(offset > 0 ? { range: `bytes=${offset}-` } : undefined),
      redirect: "follow",
      signal
    });
    if (response.status === 416 && offset === file.sizeBytes) return;
    if (!response.ok) throw this.httpError(response, file.name);
    if (offset > 0 && response.status !== 206) {
      if (record.assembly?.type === "concatenate") {
        const precedingBytes = record.snapshot.files.slice(0, record.snapshot.files.indexOf(file))
          .reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
        await truncate(target, precedingBytes);
      } else {
        await truncate(target, 0);
      }
      file.downloadedBytes = 0;
      offset = 0;
      response.body?.cancel().catch(() => undefined);
      response = await this.fetcher(url, { headers: this.requestHeaders(), redirect: "follow", signal });
      if (!response.ok) throw this.httpError(response, file.name);
    }
    if (offset > 0) {
      const range = response.headers.get("content-range")?.match(/^bytes\s+(\d+)-/i);
      if (response.status !== 206 || Number(range?.[1]) !== offset) {
        throw new Error(`Hugging Face returned an invalid resume range for ${file.name}`);
      }
    }
    if (!response.body) throw new Error(`Hugging Face returned an empty response for ${file.name}`);
    const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    const tracker = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        onBytes(chunk.length);
        callback(null, chunk);
      }
    });
    const sink = createWriteStream(target, { flags: offset > 0 || record.assembly?.type === "concatenate" ? "a" : "w", mode: 0o600 });
    await pipeline(source, tracker, sink, { signal });
  }

  private httpError(response: Response, filename: string): Error {
    if (response.status === 401 || response.status === 403) {
      return new Error(`Hugging Face denied access to ${filename}. Add an authorized Hugging Face token in DSBox.`);
    }
    if (response.status === 404) return new Error(`${filename} was not found at the pinned Hugging Face revision`);
    return new Error(`Hugging Face returned ${response.status} while downloading ${filename}`);
  }

  private async verifyFile(target: string, file: ModelDownloadFileSnapshot): Promise<boolean> {
    const size = await pathSize(target);
    if (file.sizeBytes > 0 && size !== file.sizeBytes) return false;
    if (file.sha256 && await fileSha256(target) !== file.sha256) return false;
    return size > 0;
  }

  private async destinationValid(record: DownloadRecord): Promise<boolean> {
    const destination = record.snapshot.destinationDirectory;
    if (!(await pathExists(destination))) return false;
    if (record.assembly?.type === "concatenate") {
      const output = path.join(destination, ...safeRelativeFile(record.snapshot.outputFile).split("/"));
      if (await pathSize(output) !== record.snapshot.totalBytes) return false;
      let offset = 0;
      for (const file of record.snapshot.files) {
        if (file.sha256 && await fileSha256(output, offset, file.sizeBytes) !== file.sha256) return false;
        offset += file.sizeBytes;
      }
      return true;
    }
    for (const file of record.snapshot.files) {
      const target = path.join(destination, ...safeRelativeFile(file.name).split("/"));
      if (!(await this.verifyFile(target, file))) return false;
    }
    return true;
  }

  private async markReady(record: DownloadRecord): Promise<void> {
    const modelPath = path.join(record.snapshot.destinationDirectory, ...record.snapshot.outputFile.split("/"));
    if (this.validateReadyModel) {
      await this.validateReadyModel(modelPath, record.snapshot.modelId, record.snapshot.artifactFormat);
    }
    const next = this.store.get();
    next.model.path = modelPath;
    next.model.id = record.snapshot.modelId;
    const saved = await this.store.set(next);
    this.bus.publish({ type: "config", payload: saved });
    if (this.onReady) await this.onReady(modelPath, record.snapshot.modelId);
    record.snapshot.stage = "ready";
    record.snapshot.downloadedBytes = record.snapshot.totalBytes;
    record.snapshot.speedBytesPerSecond = 0;
    record.snapshot.etaSeconds = 0;
    record.snapshot.completedAt = new Date().toISOString();
    record.snapshot.error = null;
    for (const file of record.snapshot.files) {
      file.downloadedBytes = file.sizeBytes;
      file.stage = "complete";
    }
    await this.persist();
    this.publish(record);
  }

  private async commit(record: DownloadRecord): Promise<void> {
    const destination = record.snapshot.destinationDirectory;
    const stagedOutput = path.join(record.stagingDirectory, ...safeRelativeFile(record.snapshot.outputFile).split("/"));
    if (!(await pathExists(stagedOutput))) throw new Error("The verified model output is missing from the download transaction");
    if (await pathExists(destination)) {
      if (await this.destinationValid(record)) {
        await rm(record.stagingDirectory, { recursive: true, force: true });
        return;
      }
      await rename(destination, `${destination}.invalid-${Date.now()}`);
    }
    await rename(record.stagingDirectory, destination);
  }
}
