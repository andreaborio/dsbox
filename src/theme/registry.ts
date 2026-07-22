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
export const SYSTEM_THEME_SWATCHES = ["#f5f7fb", "#ffffff", "#0b1020", "#1557ff"] as const;

export const THEME_REGISTRY: readonly ThemeDefinition[] = Object.freeze([
  {
    id: "dsbox-light",
    label: "Hebrus Light",
    description: "Bright Mac studio palette with Hebrus blue.",
    colorScheme: "light",
    canvasColor: "#f5f7fb",
    swatches: ["#f5f7fb", "#ffffff", "#080b14", "#1557ff"]
  },
  {
    id: "dsbox-dark",
    label: "Hebrus Dark",
    description: "Night engine surface with luminous blue.",
    colorScheme: "dark",
    canvasColor: "#0b1020",
    swatches: ["#0b1020", "#151c2e", "#f7f9fd", "#8aa6ff"]
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
