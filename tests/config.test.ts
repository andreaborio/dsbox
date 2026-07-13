import { describe, expect, it } from "vitest";
import { configSchema, createDefaultConfig, hardwareProfile, migrateLegacyLowMemoryDefaults } from "../server/config.js";

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

  it("migrates the legacy 32 GB cache on low-memory Macs only", () => {
    const legacy = createDefaultConfig(64 * 1024 ** 3);
    const migrated = migrateLegacyLowMemoryDefaults(legacy, 16 * 1024 ** 3);
    expect(migrated.server.contextTokens).toBe(8_192);
    expect(migrated.server.maxOutputTokens).toBe(4_096);
    expect(migrated.streaming).toMatchObject({ cacheMode: "auto", cacheSizeGb: 8 });
    expect(migrateLegacyLowMemoryDefaults(legacy, 64 * 1024 ** 3)).toEqual(legacy);
  });

  it("selects a safe 32K profile on a 64 GB Mac", () => {
    const config = createDefaultConfig(64 * 1024 ** 3);
    expect(config.repository.url).toBe("https://github.com/andreaborio/ds4.git");
    expect(config.repository.branch).toBe("main");
    expect(config.server.contextTokens).toBe(32_768);
    expect(config.streaming.enabled).toBe(true);
    expect(config.streaming.cacheMode).toBe("manual");
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
