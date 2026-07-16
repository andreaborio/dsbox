import { getThemeDefinition } from "./registry.js";
import { themeRuntime } from "./runtime.js";

function syncWindowChrome(): void {
  const definition = getThemeDefinition(themeRuntime.getSnapshot().resolvedTheme);
  document.documentElement.style.backgroundColor = definition.canvasColor;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", definition.canvasColor);
}

syncWindowChrome();
const unsubscribe = themeRuntime.subscribe(syncWindowChrome);

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribe);
}
