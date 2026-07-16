import { useSyncExternalStore } from "react";
import { themeRuntime, type ThemeSnapshot } from "./runtime.js";

export function useTheme(): ThemeSnapshot {
  return useSyncExternalStore(
    themeRuntime.subscribe,
    themeRuntime.getSnapshot,
    themeRuntime.getServerSnapshot
  );
}
