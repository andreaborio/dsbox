import { describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  createThemeRuntime,
  readThemePreference,
  resolveThemePreference,
  writeThemePreference
} from "../src/theme/runtime.js";

class FakeMediaQueryList {
  matches = false;
  private listeners = new Set<() => void>();

  addEventListener(_type: "change", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: () => void): void {
    this.listeners.delete(listener);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeWindowTarget {
  private listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();

  addEventListener(
    _type: "storage",
    listener: (event: { key: string | null; newValue: string | null }) => void
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "storage",
    listener: (event: { key: string | null; newValue: string | null }) => void
  ): void {
    this.listeners.delete(listener);
  }

  dispatch(key: string | null, newValue: string | null): void {
    for (const listener of this.listeners) listener({ key, newValue });
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function createDocumentElement() {
  const attributes = new Map<string, string>();
  return {
    attributes,
    style: { colorScheme: "" },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    }
  };
}

describe("theme runtime", () => {
  it("resolves system to the matching Hebrus Studio base theme", () => {
    expect(resolveThemePreference("system", false)).toBe("dsbox-light");
    expect(resolveThemePreference("system", true)).toBe("dsbox-dark");
    expect(resolveThemePreference("nord", false)).toBe("nord");
  });

  it("reads and writes the versioned preference and tolerates blocked storage", () => {
    const setItem = vi.fn();
    expect(readThemePreference({ getItem: (key) => key === THEME_STORAGE_KEY ? "solarized-dark" : null }))
      .toBe("solarized-dark");
    expect(readThemePreference({ getItem: () => "retired-theme" })).toBe("dsbox-light");
    expect(readThemePreference({ getItem: () => { throw new Error("blocked"); } })).toBe("dsbox-light");

    writeThemePreference({ setItem }, "nord");
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "nord");
    expect(() => writeThemePreference({ setItem: () => { throw new Error("blocked"); } }, "nord"))
      .not.toThrow();
  });

  it("applies resolved and preferred themes as document attributes", () => {
    const documentElement = createDocumentElement();
    applyThemeToDocument(documentElement, { preference: "system", resolvedTheme: "dsbox-dark" });

    expect(documentElement.attributes.get("data-ds-theme")).toBe("dsbox-dark");
    expect(documentElement.attributes.get("data-ds-theme-preference")).toBe("system");
    expect(documentElement.attributes.get("data-ds-color-scheme")).toBe("dark");
    expect(documentElement.attributes.get("data-ds-theme-ready")).toBe("");
    expect(documentElement.style.colorScheme).toBe("dark");
  });

  it("publishes stable snapshots, persists choices, and updates document state", () => {
    const mediaQueryList = new FakeMediaQueryList();
    const windowTarget = new FakeWindowTarget();
    const documentElement = createDocumentElement();
    const setItem = vi.fn();
    const runtime = createThemeRuntime({
      storage: { getItem: () => "system", setItem },
      mediaQueryList,
      windowTarget,
      documentElement
    });
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    const firstSnapshot = runtime.getSnapshot();

    expect(firstSnapshot).toEqual({ preference: "system", resolvedTheme: "dsbox-light" });
    expect(runtime.getSnapshot()).toBe(firstSnapshot);
    expect(mediaQueryList.listenerCount()).toBe(1);
    expect(windowTarget.listenerCount()).toBe(1);

    mediaQueryList.setMatches(true);
    expect(runtime.getSnapshot()).toEqual({ preference: "system", resolvedTheme: "dsbox-dark" });
    expect(documentElement.attributes.get("data-ds-theme")).toBe("dsbox-dark");
    expect(listener).toHaveBeenCalledTimes(1);

    runtime.setPreference("nord");
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "nord");
    expect(runtime.getSnapshot()).toEqual({ preference: "nord", resolvedTheme: "nord" });
    expect(documentElement.attributes.get("data-ds-theme-preference")).toBe("nord");
    expect(listener).toHaveBeenCalledTimes(2);

    mediaQueryList.setMatches(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().resolvedTheme).toBe("nord");

    unsubscribe();
    runtime.destroy();
    expect(mediaQueryList.listenerCount()).toBe(0);
    expect(windowTarget.listenerCount()).toBe(0);
  });

  it("reacts to same-key storage events without rewriting storage", () => {
    const mediaQueryList = new FakeMediaQueryList();
    const windowTarget = new FakeWindowTarget();
    const documentElement = createDocumentElement();
    const setItem = vi.fn();
    const runtime = createThemeRuntime({
      storage: { getItem: () => "dsbox-light", setItem },
      mediaQueryList,
      windowTarget,
      documentElement
    });
    const listener = vi.fn();
    runtime.subscribe(listener);

    windowTarget.dispatch("unrelated", "nord");
    expect(listener).not.toHaveBeenCalled();

    windowTarget.dispatch(THEME_STORAGE_KEY, "solarized-dark");
    expect(runtime.getSnapshot()).toEqual({
      preference: "solarized-dark",
      resolvedTheme: "solarized-dark"
    });
    expect(setItem).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);

    windowTarget.dispatch(THEME_STORAGE_KEY, null);
    expect(runtime.getSnapshot()).toEqual({ preference: "dsbox-light", resolvedTheme: "dsbox-light" });
    expect(listener).toHaveBeenCalledTimes(2);
    runtime.destroy();
  });
});
