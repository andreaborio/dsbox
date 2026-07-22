import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_ID,
  DEFAULT_THEME_PREFERENCE,
  THEME_IDS,
  THEME_REGISTRY,
  getThemeDefinition,
  isThemeId,
  isThemePreference,
  parseThemePreference
} from "../src/theme/registry.js";

describe("theme registry", () => {
  it("exposes the supported theme contract", () => {
    expect(THEME_IDS).toEqual(["dsbox-light", "dsbox-dark", "nord", "solarized-dark"]);
    expect(THEME_REGISTRY.map((theme) => theme.id)).toEqual(THEME_IDS);
    expect(DEFAULT_THEME_ID).toBe("dsbox-light");
    expect(DEFAULT_THEME_PREFERENCE).toBe("dsbox-light");
  });

  it.each(THEME_IDS)("recognizes %s as a theme id", (themeId) => {
    expect(isThemeId(themeId)).toBe(true);
    expect(isThemePreference(themeId)).toBe(true);
    expect(parseThemePreference(themeId)).toBe(themeId);
  });

  it("accepts system and rejects stale or malformed preferences", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(parseThemePreference("system")).toBe("system");
    expect(isThemeId("system")).toBe(false);
    expect(parseThemePreference("dark")).toBe("dsbox-light");
    expect(parseThemePreference(null)).toBe("dsbox-light");
  });

  it("provides the color scheme needed by the document runtime", () => {
    expect(getThemeDefinition("dsbox-light").colorScheme).toBe("light");
    expect(getThemeDefinition("dsbox-dark").colorScheme).toBe("dark");
    expect(getThemeDefinition("nord").label).toBe("Nord");
    expect(getThemeDefinition("solarized-dark").swatches).toHaveLength(4);
    expect(getThemeDefinition("dsbox-light").canvasColor).toBe("#f5f7fb");
  });
});
