export function formatBytes(value: number, precision = 1): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : precision)} ${units[index]}`;
}

export function formatPercent(value: number, precision = 0): string {
  return `${Math.max(0, value).toFixed(precision)}%`;
}

export function formatDuration(startedAt: string | null): string {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatModelName(modelId: string): string {
  const normalized = modelId.toLowerCase();
  if (normalized === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  if (normalized === "glm-5.2") return "GLM 5.2";
  if (normalized === "glm-5.2-chat") return "GLM 5.2 Chat";
  if (normalized === "glm-5.2-reasoner") return "GLM 5.2 Reasoner";
  return modelId;
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function timeLabel(timestamp: string | number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}
