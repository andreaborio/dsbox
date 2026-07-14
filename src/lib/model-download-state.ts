import type { ModelDownloadSnapshot, ModelDownloadStage } from "../types";

const ACTIVE_STAGES = new Set<ModelDownloadStage>([
  "queued",
  "preflighting",
  "downloading",
  "verifying"
]);

export function isDownloadActive(download: ModelDownloadSnapshot): boolean {
  return ACTIVE_STAGES.has(download.stage);
}

export function currentDownload(downloads: ModelDownloadSnapshot[] | undefined): ModelDownloadSnapshot | null {
  return downloads?.find(isDownloadActive) ?? null;
}

export function resumableDownload(downloads: ModelDownloadSnapshot[] | undefined): ModelDownloadSnapshot | null {
  return downloads?.find((download) => download.stage === "paused" || download.stage === "error") ?? null;
}

export function downloadStageLabel(stage: ModelDownloadStage): string {
  switch (stage) {
    case "queued": return "Preparing download";
    case "preflighting": return "Checking files and free space";
    case "downloading": return "Downloading model";
    case "verifying": return "Verifying model files";
    case "ready": return "Ready to use";
    case "paused": return "Download paused";
    case "cancelled": return "Download cancelled";
    case "error": return "Download needs attention";
  }
}

export function formatDownloadEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min left` : `${hours} hr left`;
}
