import { describe, expect, it } from "vitest";
import { parseMacVmStat, parseMacVmStatUsedBytes } from "../server/metrics.js";

describe("macOS unified memory metrics", () => {
  it("counts inactive and speculative file cache as reclaimable", () => {
    const output = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    33045.
Pages active:                                1282877.
Pages inactive:                              2297042.
Pages speculative:                             21841.
Pages wired down:                             296074.
Pages purgeable:                               89762.
File-backed pages:                           2461688.
Anonymous pages:                             1140072.
Pages occupied by compressor:                 203029.
`;
    const total = 64 * 1024 ** 3;
    const used = parseMacVmStatUsedBytes(output, total);

    expect(used).not.toBeNull();
    expect(used! / total).toBeGreaterThan(0.3);
    expect(used! / total).toBeLessThan(0.45);
    expect(parseMacVmStat(output, total)?.fileCacheBytes).toBe(2_461_688 * 16_384);
  });

  it("returns null for incomplete output instead of inventing a value", () => {
    expect(parseMacVmStatUsedBytes("Pages free: 10.", 64 * 1024 ** 3)).toBeNull();
  });

  it("supports 4K pages and the alternative VM compressor label", () => {
    const output = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages wired down: 200.
Pages purgeable: 100.
File-backed pages: 400.
Anonymous pages: 1000.
Pages used by VM compressor: 50.
`;
    const parsed = parseMacVmStat(output, 8 * 1024 ** 3);

    expect(parsed).toEqual({
      usedBytes: (900 + 200 + 50) * 4096,
      fileCacheBytes: 400 * 4096
    });
  });

  it("never subtracts purgeable pages below zero", () => {
    const output = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down: 20.
Pages purgeable: 500.
File-backed pages: 80.
Anonymous pages: 100.
Pages occupied by compressor: 10.
`;

    expect(parseMacVmStatUsedBytes(output, 8 * 1024 ** 3)).toBe((20 + 10) * 16_384);
  });
});
