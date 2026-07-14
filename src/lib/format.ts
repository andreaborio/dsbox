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
  const trimmed = modelId.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  if (normalized === "glm-5.2") return "GLM 5.2";
  if (normalized === "glm-5.2-chat") return "GLM 5.2 Chat";
  if (normalized === "glm-5.2-reasoner") return "GLM 5.2 Reasoner";

  const qwenIdentity = trimmed.replace(/^qwen(\d+)-(\d)(?=[-_.]|$)/i, "qwen$1.$2");
  const qwen = qwenIdentity.match(/^qwen[-_.]?(\d+(?:[._]\d+)?)(.*)$/i);
  if (qwen) {
    const version = qwen[1].replace("_", ".");
    const suffix = qwen[2]
      .replace(/^[-_.]+/, "")
      .split(/[-_.]+/)
      .filter(Boolean)
      .map((token) => /^(?:a?\d+(?:\.\d+)?[bmk]|vl)$/i.test(token)
        ? token.toUpperCase()
        : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
      .join(" ");
    return `Qwen${version}${suffix ? ` ${suffix}` : ""}`;
  }

  return trimmed || modelId;
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
