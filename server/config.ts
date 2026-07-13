import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { DsboxConfig } from "../src/types.js";
import { hasArgumentOption } from "../src/lib/arguments.js";

const positiveInt = z.number().int().positive();

const baseConfigSchema = z.object({
  repository: z.object({
    url: z.string().url().refine((value) => value.startsWith("https://"), "Use an HTTPS repository URL"),
    branch: z.string().min(1).max(160).regex(/^[A-Za-z0-9._\/-]+$/),
    directory: z.string().min(1)
  }),
  model: z.object({
    path: z.string().min(1),
    id: z.string().min(1).max(160)
  }),
  server: z.object({
    internalHost: z.literal("127.0.0.1"),
    internalPort: z.number().int().min(1024).max(65535),
    contextTokens: positiveInt.max(1_000_000),
    maxOutputTokens: positiveInt.max(393_216),
    powerPercent: z.number().int().min(1).max(100),
    threads: positiveInt.max(256),
    prefillChunk: positiveInt.max(65_536).nullable(),
    quality: z.boolean(),
    warmWeights: z.boolean()
  }),
  streaming: z.object({
    enabled: z.boolean(),
    cacheMode: z.enum(["auto", "manual"]),
    cacheSizeGb: z.number().int().min(1).max(1024),
    coldStart: z.boolean(),
    preloadExperts: positiveInt.max(100_000).nullable()
  }),
  kvCache: z.object({
    enabled: z.boolean(),
    directory: z.string().min(1),
    spaceMb: positiveInt.max(1_048_576),
    minTokens: z.number().int().min(0).max(1_000_000),
    continuedIntervalTokens: z.number().int().min(0).max(1_000_000)
  }),
  observability: z.object({
    traceEnabled: z.boolean(),
    tracePath: z.string().min(1),
    imatrixEnabled: z.boolean(),
    imatrixPath: z.string().min(1),
    imatrixEvery: z.number().int().min(0).max(1_000_000)
  }),
  gateway: z.object({
    requireApiKey: z.boolean(),
    apiKey: z.string().min(8).max(256)
  }),
  advanced: z.object({
    extraArgs: z.string().max(16_384),
    environment: z.string().max(65_536)
  })
});

const legacyConfigSchema = baseConfigSchema.extend({ version: z.literal(1) });
export const configSchema: z.ZodType<DsboxConfig> = baseConfigSchema.extend({ version: z.literal(2) });
export type LegacyDsboxConfig = z.infer<typeof legacyConfigSchema>;

export interface HardwareProfile {
  contextTokens: number;
  maxOutputTokens: number;
  cacheMode: "auto" | "manual";
  cacheSizeGb: number;
}

export function hardwareProfile(totalMemory: number): HardwareProfile {
  const gib = totalMemory / 1024 ** 3;
  if (gib <= 18) return { contextTokens: 8_192, maxOutputTokens: 4_096, cacheMode: "auto", cacheSizeGb: 8 };
  if (gib <= 26) return { contextTokens: 16_384, maxOutputTokens: 8_192, cacheMode: "auto", cacheSizeGb: 12 };
  if (gib <= 40) return { contextTokens: 32_768, maxOutputTokens: 16_384, cacheMode: "auto", cacheSizeGb: 20 };
  if (gib <= 72) return { contextTokens: 32_768, maxOutputTokens: 32_768, cacheMode: "auto", cacheSizeGb: 32 };
  if (gib <= 160) return { contextTokens: 100_000, maxOutputTokens: 32_768, cacheMode: "auto", cacheSizeGb: 32 };
  return { contextTokens: 200_000, maxOutputTokens: 32_768, cacheMode: "auto", cacheSizeGb: 32 };
}

export function migrateVersion1Config(config: LegacyDsboxConfig, totalMemory: number): DsboxConfig {
  const profile = hardwareProfile(totalMemory);
  const legacyDefaultProfile = config.server.contextTokens === 32_768
    && config.server.maxOutputTokens === 32_768
    && config.streaming.enabled
    && config.streaming.cacheMode === "manual"
    && config.streaming.cacheSizeGb === 32
    && !config.streaming.coldStart
    && config.streaming.preloadExperts === null
    && !hasArgumentOption(config.advanced.extraArgs, "--ssd-streaming-cache-experts");
  if (!legacyDefaultProfile) return { ...config, version: 2 };
  return {
    ...config,
    version: 2,
    server: {
      ...config.server,
      contextTokens: profile.contextTokens,
      maxOutputTokens: config.server.maxOutputTokens === 32_768 ? profile.maxOutputTokens : config.server.maxOutputTokens
    },
    streaming: {
      ...config.streaming,
      cacheMode: profile.cacheMode,
      cacheSizeGb: profile.cacheSizeGb
    }
  };
}

export function createDefaultConfig(totalMemory: number): DsboxConfig {
  const home = process.env.DSBOX_HOME || path.join(homedir(), ".dsbox");
  const runtimeDirectory = path.join(home, "runtime", "andreaborio-ds4");
  const profile = hardwareProfile(totalMemory);
  return {
    version: 2,
    repository: {
      url: "https://github.com/andreaborio/ds4.git",
      branch: "main",
      directory: runtimeDirectory
    },
    model: {
      path: path.join(runtimeDirectory, "ds4flash.gguf"),
      id: "deepseek-v4-flash"
    },
    server: {
      internalHost: "127.0.0.1",
      internalPort: 8000,
      contextTokens: profile.contextTokens,
      maxOutputTokens: profile.maxOutputTokens,
      powerPercent: 100,
      threads: Math.max(2, Math.min(16, Number(process.env.DSBOX_DEFAULT_THREADS) || 8)),
      prefillChunk: null,
      quality: false,
      warmWeights: false
    },
    streaming: {
      enabled: true,
      cacheMode: profile.cacheMode,
      cacheSizeGb: profile.cacheSizeGb,
      coldStart: false,
      preloadExperts: null
    },
    kvCache: {
      enabled: true,
      directory: path.join(home, "cache", "kv"),
      spaceMb: 8192,
      minTokens: 512,
      continuedIntervalTokens: 10_000
    },
    observability: {
      traceEnabled: false,
      tracePath: path.join(home, "logs", "ds4.trace"),
      imatrixEnabled: false,
      imatrixPath: path.join(home, "imatrix", "live-imatrix.dat"),
      imatrixEvery: 64
    },
    gateway: {
      requireApiKey: false,
      apiKey: `dsbox-${randomBytes(12).toString("hex")}`
    },
    advanced: {
      extraArgs: "",
      environment: ""
    }
  };
}

export class ConfigStore {
  readonly homeDirectory: string;
  readonly configPath: string;
  private config: DsboxConfig;

  private constructor(config: DsboxConfig, homeDirectory: string) {
    this.config = config;
    this.homeDirectory = homeDirectory;
    this.configPath = path.join(homeDirectory, "config.json");
  }

  static async open(totalMemory: number): Promise<ConfigStore> {
    const homeDirectory = process.env.DSBOX_HOME || path.join(homedir(), ".dsbox");
    await mkdir(homeDirectory, { recursive: true });
    const configPath = path.join(homeDirectory, "config.json");
    let config: DsboxConfig;
    try {
      const raw = await readFile(configPath, "utf8");
      const candidate = JSON.parse(raw) as { version?: unknown };
      if (candidate.version === 1) {
        config = migrateVersion1Config(legacyConfigSchema.parse(candidate), totalMemory);
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      } else {
        config = configSchema.parse(candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof z.ZodError)) {
        throw error;
      }
      config = createDefaultConfig(totalMemory);
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    }
    return new ConfigStore(config, homeDirectory);
  }

  get(): DsboxConfig {
    return structuredClone(this.config);
  }

  async set(next: unknown): Promise<DsboxConfig> {
    const parsed = configSchema.parse(next);
    const temporaryPath = `${this.configPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.configPath);
    this.config = parsed;
    return this.get();
  }
}
