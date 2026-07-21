import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigStore,
  configSchema,
  createDefaultConfig,
  hardwareProfile,
  migrateVersion1Config,
  type LegacyDsboxConfig
} from "../server/config.js";
import { persistedConfigFixtures } from "./fixtures/hebrus-runtime-compatibility.js";

describe("default config", () => {
  it("prioritizes expert-cache headroom on a 16 GB Mac", () => {
    const config = createDefaultConfig(16 * 1024 ** 3);
    expect(config.server.contextTokens).toBe(8_192);
    expect(config.server.maxOutputTokens).toBe(4_096);
    expect(config.streaming.cacheMode).toBe("auto");
    expect(config.streaming.cacheSizeGb).toBe(8);
  });

  it("scales low-memory profiles without reducing Metal power", () => {
    expect(hardwareProfile(24 * 1024 ** 3)).toEqual({ contextTokens: 16_384, maxOutputTokens: 8_192, cacheMode: "auto", cacheSizeGb: 12 });
    expect(hardwareProfile(32 * 1024 ** 3)).toEqual({ contextTokens: 32_768, maxOutputTokens: 16_384, cacheMode: "auto", cacheSizeGb: 20 });
    expect(createDefaultConfig(16 * 1024 ** 3).server.powerPercent).toBe(100);
  });

  it("migrates the version-1 default cache exactly once on 16 and 64 GB Macs", () => {
    const legacy = { ...createDefaultConfig(64 * 1024 ** 3), version: 1 } as LegacyDsboxConfig;
    legacy.streaming.cacheMode = "manual";
    const migrated = migrateVersion1Config(legacy, 16 * 1024 ** 3);
    expect(migrated.version).toBe(2);
    expect(migrated.server.contextTokens).toBe(8_192);
    expect(migrated.server.maxOutputTokens).toBe(4_096);
    expect(migrated.streaming).toMatchObject({ cacheMode: "auto", cacheSizeGb: 8 });
    expect(migrateVersion1Config(legacy, 64 * 1024 ** 3).streaming.cacheMode).toBe("auto");
  });

  it("preserves an explicit version-1 cache override during migration", () => {
    const legacy = { ...createDefaultConfig(64 * 1024 ** 3), version: 1 } as LegacyDsboxConfig;
    legacy.streaming.cacheMode = "manual";
    legacy.advanced.extraArgs = "--ssd-streaming-cache-experts=4342";
    const migrated = migrateVersion1Config(legacy, 64 * 1024 ** 3);
    expect(migrated).toMatchObject({
      version: 2,
      streaming: { cacheMode: "manual", cacheSizeGb: 32 }
    });
  });

  it("selects a safe 32K profile on a 64 GB Mac", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    expect(config.repository.url).toBe("https://github.com/andreaborio/ds4.git");
    expect(config.repository.branch).toBe("main");
    expect(config.server.contextTokens).toBe(32_768);
    expect(config.streaming.enabled).toBe(true);
    expect(config.streaming.cacheMode).toBe("auto");
    expect(config.kvCache.enabled).toBe(true);
    expect(config.server.internalHost).toBe("127.0.0.1");
  });

  it("uses automatic cache sizing with more unified memory", () => {
    const config = createDefaultConfig(128 * 1024 ** 3);
    expect(config.server.contextTokens).toBe(100_000);
    expect(config.streaming.cacheMode).toBe("auto");
  });

  it("refuses non-loopback ds4 hosts and non-HTTPS repositories", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    expect(() => configSchema.parse({ ...config, server: { ...config.server, internalHost: "0.0.0.0" } })).toThrow();
    expect(() => configSchema.parse({ ...config, repository: { ...config.repository, url: "git@github.com:andreaborio/ds4.git" } })).toThrow();
  });
});

describe("Hebrus bridge persistence", () => {
  it.each(persistedConfigFixtures)("opens the version-2 $name fixture twice without rewriting or losing paths", async ({ config }) => {
    const home = await mkdtemp(path.join(tmpdir(), "dsbox-hebrus-config-"));
    const configPath = path.join(home, "config.json");
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    const previousHome = process.env.DSBOX_HOME;
    process.env.DSBOX_HOME = home;
    try {
      await writeFile(configPath, serialized, { mode: 0o600 });

      const first = await ConfigStore.open(64 * 1024 ** 3);
      const second = await ConfigStore.open(64 * 1024 ** 3);

      expect(first.homeDirectory).toBe(home);
      expect(second.homeDirectory).toBe(home);
      expect(first.get()).toEqual(config);
      expect(second.get()).toEqual(config);
      expect(first.get().version).toBe(2);
      expect(path.isAbsolute(first.get().repository.directory)).toBe(true);
      expect(path.isAbsolute(first.get().model.path)).toBe(true);
      expect(path.isAbsolute(first.get().kvCache.directory)).toBe(true);
      expect(await readFile(configPath, "utf8")).toBe(serialized);
    } finally {
      if (previousHome === undefined) delete process.env.DSBOX_HOME;
      else process.env.DSBOX_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});
