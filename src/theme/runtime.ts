import {
  DEFAULT_THEME_ID,
  getThemeDefinition,
  parseThemePreference,
  type ThemeId,
  type ThemePreference
} from "./registry.js";

export const THEME_STORAGE_KEY = "dsbox:appearance-theme:v1";
export const SYSTEM_DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

type ThemeListener = () => void;

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ThemeMediaQueryList {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: ThemeListener): void;
  removeEventListener?(type: "change", listener: ThemeListener): void;
  addListener?(listener: ThemeListener): void;
  removeListener?(listener: ThemeListener): void;
}

interface ThemeStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

interface ThemeWindowTarget {
  addEventListener(type: "storage", listener: (event: ThemeStorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: ThemeStorageEvent) => void): void;
}

interface ThemeDocumentElement {
  setAttribute(name: string, value: string): void;
  style?: {
    colorScheme: string;
  };
}

export interface ThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ThemeId;
}

export interface ThemeRuntimeOptions {
  storage?: ThemeStorage | null;
  mediaQueryList?: ThemeMediaQueryList | null;
  windowTarget?: ThemeWindowTarget | null;
  documentElement?: ThemeDocumentElement | null;
  initialPreference?: ThemePreference;
  autoStart?: boolean;
}

export function resolveThemePreference(preference: ThemePreference, prefersDark: boolean): ThemeId {
  if (preference !== "system") return preference;
  return prefersDark ? "dsbox-dark" : DEFAULT_THEME_ID;
}

export function readThemePreference(storage: Pick<ThemeStorage, "getItem"> | null): ThemePreference {
  if (!storage) return DEFAULT_THEME_ID;

  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function writeThemePreference(
  storage: Pick<ThemeStorage, "setItem"> | null,
  preference: ThemePreference
): void {
  if (!storage) return;

  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Appearance changes still apply for this session when storage is blocked.
  }
}

export function applyThemeToDocument(
  documentElement: ThemeDocumentElement | null,
  snapshot: ThemeSnapshot
): void {
  if (!documentElement) return;

  const definition = getThemeDefinition(snapshot.resolvedTheme);
  documentElement.setAttribute("data-ds-theme", snapshot.resolvedTheme);
  documentElement.setAttribute("data-ds-theme-preference", snapshot.preference);
  documentElement.setAttribute("data-ds-color-scheme", definition.colorScheme);
  documentElement.setAttribute("data-ds-theme-ready", "");
  if (documentElement.style) {
    documentElement.style.colorScheme = definition.colorScheme;
  }
}

function getBrowserStorage(): ThemeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getBrowserMediaQueryList(): ThemeMediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(SYSTEM_DARK_MEDIA_QUERY);
}

function getBrowserWindowTarget(): ThemeWindowTarget | null {
  return typeof window === "undefined" ? null : window;
}

function getBrowserDocumentElement(): ThemeDocumentElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

function dependencyOrDefault<T>(options: ThemeRuntimeOptions, key: keyof ThemeRuntimeOptions, fallback: T): T {
  return Object.prototype.hasOwnProperty.call(options, key) ? options[key] as T : fallback;
}

export class ThemeRuntime {
  private readonly storage: ThemeStorage | null;
  private readonly mediaQueryList: ThemeMediaQueryList | null;
  private readonly windowTarget: ThemeWindowTarget | null;
  private readonly documentElement: ThemeDocumentElement | null;
  private readonly listeners = new Set<ThemeListener>();
  private snapshot: ThemeSnapshot;
  private started = false;

  constructor(options: ThemeRuntimeOptions = {}) {
    this.storage = dependencyOrDefault(options, "storage", getBrowserStorage());
    this.mediaQueryList = dependencyOrDefault(options, "mediaQueryList", getBrowserMediaQueryList());
    this.windowTarget = dependencyOrDefault(options, "windowTarget", getBrowserWindowTarget());
    this.documentElement = dependencyOrDefault(options, "documentElement", getBrowserDocumentElement());

    const preference = options.initialPreference ?? readThemePreference(this.storage);
    this.snapshot = this.createSnapshot(preference);
    applyThemeToDocument(this.documentElement, this.snapshot);

    if (options.autoStart !== false) this.start();
  }

  getSnapshot = (): ThemeSnapshot => this.snapshot;

  getServerSnapshot = (): ThemeSnapshot => this.snapshot;

  subscribe = (listener: ThemeListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setPreference = (preference: ThemePreference): void => {
    const nextPreference = parseThemePreference(preference);
    writeThemePreference(this.storage, nextPreference);
    this.update(nextPreference);
  };

  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.mediaQueryList?.addEventListener) {
      this.mediaQueryList.addEventListener("change", this.handleMediaChange);
    } else {
      this.mediaQueryList?.addListener?.(this.handleMediaChange);
    }
    this.windowTarget?.addEventListener("storage", this.handleStorage);
  }

  destroy(): void {
    if (!this.started) return;
    this.started = false;

    if (this.mediaQueryList?.removeEventListener) {
      this.mediaQueryList.removeEventListener("change", this.handleMediaChange);
    } else {
      this.mediaQueryList?.removeListener?.(this.handleMediaChange);
    }
    this.windowTarget?.removeEventListener("storage", this.handleStorage);
    this.listeners.clear();
  }

  private readonly handleMediaChange = (): void => {
    if (this.snapshot.preference === "system") this.update("system");
  };

  private readonly handleStorage = (event: ThemeStorageEvent): void => {
    if (event.key !== THEME_STORAGE_KEY) return;
    this.update(parseThemePreference(event.newValue));
  };

  private createSnapshot(preference: ThemePreference): ThemeSnapshot {
    return Object.freeze({
      preference,
      resolvedTheme: resolveThemePreference(preference, this.mediaQueryList?.matches ?? false)
    });
  }

  private update(preference: ThemePreference): void {
    const next = this.createSnapshot(preference);
    if (
      next.preference === this.snapshot.preference
      && next.resolvedTheme === this.snapshot.resolvedTheme
    ) return;

    this.snapshot = next;
    applyThemeToDocument(this.documentElement, next);
    for (const listener of this.listeners) listener();
  }
}

export function createThemeRuntime(options: ThemeRuntimeOptions = {}): ThemeRuntime {
  return new ThemeRuntime(options);
}

export const themeRuntime = createThemeRuntime();
