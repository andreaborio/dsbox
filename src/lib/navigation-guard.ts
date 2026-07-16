import type { ViewId } from "../types.js";

export function navigationNeedsSettingsConfirmation(
  currentView: ViewId,
  nextView: ViewId,
  settingsDirty: boolean
): boolean {
  return currentView === "settings" && nextView !== currentView && settingsDirty;
}
