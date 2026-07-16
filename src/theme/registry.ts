export const THEME_IDS = ["dsbox-light", "dsbox-dark", "nord", "solarized-dark"] as const;

export type ThemeId = (typeof THEME_IDS)[number];
export type ThemePreference = "system" | ThemeId;
export type ThemeColorScheme = "light" | "dark";

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  description: string;
  colorScheme: ThemeColorScheme;
  canvasColor: string;
  swatches: readonly [string, string, string, string];
}

export const DEFAULT_THEME_ID: ThemeId = "dsbox-light";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = DEFAULT_THEME_ID;
export const SYSTEM_THEME_SWATCHES = ["#fcfcfb", "#f4f4f2", "#292927", "#8377de"] as const;

export const THEME_REGISTRY: readonly ThemeDefinition[] = Object.freeze([
  {
    id: "dsbox-light",
    label: "DSBox Light",
    description: "The original quiet, warm workspace.",
    colorScheme: "light",
    canvasColor: "#fcfcfb",
    swatches: ["#fcfcfb", "#ffffff", "#191918", "#6658d3"]
  },
  {
    id: "dsbox-dark",
    label: "DSBox Dark",
    description: "Low-glare charcoal with DSBox violet.",
    colorScheme: "dark",
    canvasColor: "#171716",
    swatches: ["#171716", "#292927", "#f2f2ef", "#8377de"]
  },
  {
    id: "nord",
    label: "Nord",
    description: "Cool arctic blues inspired by editor themes.",
    colorScheme: "dark",
    canvasColor: "#2e3440",
    swatches: ["#2e3440", "#3b4252", "#eceff4", "#88c0d0"]
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Balanced blue-green contrast for long sessions.",
    colorScheme: "dark",
    canvasColor: "#002b36",
    swatches: ["#002b36", "#073642", "#eee8d5", "#2aa198"]
  }
]);

const themeIds = new Set<ThemeId>(THEME_IDS);
const themesById = new Map(THEME_REGISTRY.map((theme) => [theme.id, theme]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && themeIds.has(value as ThemeId);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || isThemeId(value);
}

export function parseThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
}

export function getThemeDefinition(themeId: ThemeId): ThemeDefinition {
  return themesById.get(themeId) ?? themesById.get(DEFAULT_THEME_ID)!;
}
