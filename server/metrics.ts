import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { MetricSample } from "../src/types.js";
import { ConfigStore } from "./config.js";
import { EventBus } from "./event-bus.js";
import { RuntimeManager } from "./runtime.js";

const execFileAsync = promisify(execFile);

interface CpuTimes {
  idle: number;
  total: number;
}

export function parseMacVmStat(output: string, totalBytes: number): { usedBytes: number; fileCacheBytes: number } | null {
  const pageSizeMatch = output.match(/page size of\s+(\d+)\s+bytes/i);
  if (!pageSizeMatch) return null;
  const pageSize = Number(pageSizeMatch[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const pages = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"?([^":]+)"?:\s+(\d+)\.?\s*$/);
    if (match) pages.set(match[1].trim().toLowerCase(), Number(match[2]));
  }
  const anonymous = pages.get("anonymous pages");
  const purgeable = pages.get("pages purgeable") ?? 0;
  const wired = pages.get("pages wired down");
  const compressor = pages.get("pages occupied by compressor") ?? pages.get("pages used by vm compressor");
  const fileBacked = pages.get("file-backed pages");
  if (![anonymous, wired, compressor, fileBacked].every((value) => Number.isFinite(value))) return null;

  // Activity Monitor-style committed estimate. File-backed pages are reported
  // separately: they may contain mmap'd model weights, but macOS can reclaim them.
  const committedPages = Math.max(0, anonymous! - purgeable) + wired! + compressor!;
  return {
    usedBytes: Math.max(0, Math.min(totalBytes, committedPages * pageSize)),
    fileCacheBytes: Math.max(0, Math.min(totalBytes, fileBacked! * pageSize))
  };
}

export function parseMacVmStatUsedBytes(output: string, totalBytes: number): number | null {
  return parseMacVmStat(output, totalBytes)?.usedBytes ?? null;
}

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

export class MetricsMonitor {
  private readonly store: ConfigStore;
  private readonly runtime: RuntimeManager;
  private readonly bus: EventBus;
  private history: MetricSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private previousCpu = cpuTimes();
  private tokensPerSecond: number | null = null;
  private swap = { used: 0, total: 0 };
  private memoryPressurePercent: number | null = null;
  private memoryPressureLevel: MetricSample["memoryPressureLevel"] = null;
  private memoryUsedBytes: number | null = null;
  private memoryFileCacheBytes = 0;
  private sampleCount = 0;

  constructor(store: ConfigStore, runtime: RuntimeManager, bus: EventBus) {
    this.store = store;
    this.runtime = runtime;
    this.bus = bus;
    bus.on("event", (event: { type: string; payload?: unknown }) => {
      if (event.type === "runtime") {
        const phase = (event.payload as { phase?: string })?.phase;
        if (phase === "starting" || phase === "idle" || phase === "error") this.tokensPerSecond = null;
        return;
      }
      if (event.type !== "log") return;
      const message = (event.payload as { message?: string })?.message ?? "";
      const matches = [...message.matchAll(/(?:avg=|decode(?:[^\d]+))([0-9]+(?:\.[0-9]+)?)\s*(?:t\/s|tok\/s)/gi)];
      const last = matches.at(-1);
      if (last) this.tokensPerSecond = Number(last[1]);
    });
  }

  getHistory(): MetricSample[] {
    return structuredClone(this.history);
  }

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async processMetrics(pid: number | null): Promise<{ cpu: number; rss: number }> {
    if (!pid) return { cpu: 0, rss: 0 };
    try {
      const result = await execFileAsync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], { timeout: 700 });
      const [cpuValue, rssKb] = result.stdout.trim().split(/\s+/).map(Number);
      return {
        cpu: Number.isFinite(cpuValue) ? cpuValue : 0,
        rss: Number.isFinite(rssKb) ? rssKb * 1024 : 0
      };
    } catch {
      return { cpu: 0, rss: 0 };
    }
  }

  private async diskMetrics(target: string): Promise<{ free: number; total: number }> {
    let current = target;
    while (current !== path.dirname(current)) {
      try {
        const stats = await statfs(current);
        return {
          free: Number(stats.bavail) * Number(stats.bsize),
          total: Number(stats.blocks) * Number(stats.bsize)
        };
      } catch {
        current = path.dirname(current);
      }
    }
    return { free: 0, total: 0 };
  }

  private async slowSystemMetrics(): Promise<void> {
    if (process.platform !== "darwin") return;
    const [swapResult, pressureResult, pressureLevelResult, vmStatResult] = await Promise.all([
      execFileAsync("sysctl", ["-n", "vm.swapusage"], { timeout: 900 }).catch(() => null),
      execFileAsync("memory_pressure", ["-Q"], { timeout: 1400 }).catch(() => null),
      execFileAsync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 900 }).catch(() => null),
      execFileAsync("vm_stat", [], { timeout: 900 }).catch(() => null)
    ]);
    if (swapResult) {
      const totalMatch = swapResult.stdout.match(/total\s*=\s*([0-9.]+)([MG])/i);
      const usedMatch = swapResult.stdout.match(/used\s*=\s*([0-9.]+)([MG])/i);
      const toBytes = (match: RegExpMatchArray | null) => {
        if (!match) return 0;
        return Number(match[1]) * (match[2].toUpperCase() === "G" ? 1024 ** 3 : 1024 ** 2);
      };
      this.swap = { total: toBytes(totalMatch), used: toBytes(usedMatch) };
    }
    if (pressureResult) {
      const freeMatch = pressureResult.stdout.match(/free percentage:\s*([0-9.]+)%/i);
      this.memoryPressurePercent = freeMatch ? Math.max(0, Math.min(100, 100 - Number(freeMatch[1]))) : null;
    }
    if (pressureLevelResult) {
      const level = Number(pressureLevelResult.stdout.trim());
      this.memoryPressureLevel = level >= 4 ? "critical" : level >= 2 ? "warning" : level >= 1 ? "normal" : null;
    }
    if (vmStatResult) {
      const memory = parseMacVmStat(vmStatResult.stdout, totalmem());
      this.memoryUsedBytes = memory?.usedBytes ?? null;
      this.memoryFileCacheBytes = memory?.fileCacheBytes ?? 0;
    }
  }

  private async sample(): Promise<void> {
    this.sampleCount += 1;
    if (this.sampleCount === 1 || this.sampleCount % 5 === 0) await this.slowSystemMetrics();
    const nowCpu = cpuTimes();
    const totalDelta = nowCpu.total - this.previousCpu.total;
    const idleDelta = nowCpu.idle - this.previousCpu.idle;
    this.previousCpu = nowCpu;
    const systemCpuPercent = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
    const [process, disk] = await Promise.all([
      this.processMetrics(this.runtime.getPid()),
      this.diskMetrics(this.store.get().repository.directory)
    ]);
    const sample: MetricSample = {
      timestamp: Date.now(),
      systemCpuPercent: Math.max(0, Math.min(100, systemCpuPercent)),
      memoryUsedBytes: this.memoryUsedBytes ?? totalmem() - freemem(),
      memoryTotalBytes: totalmem(),
      memoryFileCacheBytes: this.memoryFileCacheBytes,
      swapUsedBytes: this.swap.used,
      swapTotalBytes: this.swap.total,
      memoryPressurePercent: this.memoryPressurePercent,
      memoryPressureLevel: this.memoryPressureLevel,
      processCpuPercent: process.cpu,
      processRssBytes: process.rss,
      diskFreeBytes: disk.free,
      diskTotalBytes: disk.total,
      tokensPerSecond: this.runtime.getPid() ? this.tokensPerSecond : null,
      loadAverage: loadavg()[0] ?? 0
    };
    this.history.push(sample);
    if (this.history.length > 180) this.history.shift();
    this.bus.publish({ type: "metrics", payload: sample });
  }
}
