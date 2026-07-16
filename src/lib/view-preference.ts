import type { ViewId } from "../types.js";

export const VIEW_PREFERENCE_KEY = "dsbox:last-view:v1";
const validViewIds = new Set<ViewId>(["chat", "models", "runtime", "agents", "monitor", "settings"]);

export function parseViewPreference(value: string | null): ViewId {
  return value && validViewIds.has(value as ViewId) ? value as ViewId : "chat";
}

export function readViewPreference(storage: Pick<Storage, "getItem">): ViewId {
  try {
    return parseViewPreference(storage.getItem(VIEW_PREFERENCE_KEY));
  } catch {
    return "chat";
  }
}

export function writeViewPreference(storage: Pick<Storage, "setItem">, view: ViewId): void {
  try {
    storage.setItem(VIEW_PREFERENCE_KEY, view);
  } catch {
    // The UI still navigates when storage is unavailable.
  }
}
