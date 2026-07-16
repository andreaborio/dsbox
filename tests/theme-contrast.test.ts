import fs from "node:fs";
import path from "node:path";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

type Variables = Record<string, string>;

function variablesFor(root: Root, selector: string): Variables {
  const variables: Variables = {};
  root.walkRules((rule) => {
    if (rule.selector !== selector && !rule.selector.split(",").map((part) => part.trim()).includes(selector)) return;
    rule.walkDecls((declaration) => {
      if (declaration.prop.startsWith("--")) variables[declaration.prop] = declaration.value.trim();
    });
  });
  return variables;
}

function resolveColor(variable: string, variables: Variables): string {
  let value = variables[variable];
  const visited = new Set<string>();
  while (value?.startsWith("var(")) {
    const next = value.match(/^var\((--[^),]+)\)$/)?.[1];
    if (!next || visited.has(next)) break;
    visited.add(next);
    value = variables[next];
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Expected an opaque hex color for ${variable}, received ${value}`);
  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const tokenRoot = postcss.parse(fs.readFileSync(path.resolve("src/design-system/tokens.css"), "utf8"));
const themeRoot = postcss.parse(fs.readFileSync(path.resolve("src/design-system/themes.css"), "utf8"));
const light = variablesFor(tokenRoot, ":root");
const dark = { ...light, ...variablesFor(tokenRoot, '[data-ds-color-scheme="dark"]') };
const palettes: Record<string, Variables> = {
  "dsbox-light": light,
  "dsbox-dark": dark,
  nord: { ...dark, ...variablesFor(themeRoot, '[data-ds-theme="nord"]') },
  "solarized-dark": { ...dark, ...variablesFor(themeRoot, '[data-ds-theme="solarized-dark"]') }
};

describe("theme contrast guardrails", () => {
  it.each(Object.entries(palettes))("keeps %s text and controls legible", (_theme, variables) => {
    const canvas = resolveColor("--ds-color-bg-canvas", variables);
    const surface = resolveColor("--ds-color-bg-surface", variables);
    const primary = resolveColor("--ds-color-text-primary", variables);
    const secondary = resolveColor("--ds-color-text-secondary", variables);
    const inverse = resolveColor("--ds-color-text-inverse", variables);
    const success = resolveColor("--ds-color-status-success", variables);
    const accent = resolveColor("--ds-color-accent-solid", variables);
    const focus = resolveColor("--ds-color-border-focus", variables);

    expect(contrast(primary, canvas)).toBeGreaterThanOrEqual(7);
    expect(contrast(primary, surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(secondary, canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inverse, success)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, canvas)).toBeGreaterThanOrEqual(3);
    expect(contrast(focus, canvas)).toBeGreaterThanOrEqual(3);
  });
});
