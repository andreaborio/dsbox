import { describe, expect, it } from "vitest";
import { configSchema, createDefaultConfig } from "../server/config.js";

describe("default config", () => {
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

