#!/usr/bin/env node

import fs from "node:fs/promises";
import postcss from "postcss";

const target = new URL("../src/styles.css", import.meta.url);
const colorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

function parseColor(value) {
  if (value.startsWith("#")) {
    const raw = value.slice(1);
    const expanded = raw.length <= 4 ? [...raw].map((part) => part + part).join("") : raw;
    const hasAlpha = expanded.length === 8;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: hasAlpha ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1
    };
  }

  const parts = value.slice(value.indexOf("(") + 1, -1).split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}

function colorMetrics({ r, g, b }) {
  const channels = [r, g, b].map((channel) => channel / 255);
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  const delta = max - min;
  const luminanceChannels = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * luminanceChannels[0] + 0.7152 * luminanceChannels[1] + 0.0722 * luminanceChannels[2];
  const saturation = max === 0 ? 0 : delta / max;
  let hue = 0;
  if (delta !== 0) {
    if (max === channels[0]) hue = 60 * (((channels[1] - channels[2]) / delta) % 6);
    else if (max === channels[1]) hue = 60 * (((channels[2] - channels[0]) / delta) + 2);
    else hue = 60 * (((channels[0] - channels[1]) / delta) + 4);
  }
  if (hue < 0) hue += 360;
  return { luminance, saturation, hue };
}

function withAlpha(token, alpha) {
  if (alpha >= 0.995) return token;
  if (alpha <= 0.005) return "transparent";
  return `color-mix(in srgb, ${token} ${Math.round(alpha * 1000) / 10}%, transparent)`;
}

function semanticFamily(hue) {
  if (hue < 18 || hue >= 345) return "danger";
  if (hue < 78) return "advisory";
  if (hue < 172) return "success";
  if (hue < 258) return "info";
  if (hue < 330) return "accent";
  return "danger";
}

function familyToken(family, kind) {
  if (family === "accent") {
    if (kind === "text") return "var(--ds-color-text-accent)";
    if (kind === "soft") return "var(--ds-color-accent-soft)";
    return "var(--ds-color-accent-solid)";
  }
  if (kind === "text") return `var(--ds-color-text-${family === "info" ? "secondary" : family})`;
  return `var(--ds-color-status-${family}${kind === "soft" ? "-soft" : ""})`;
}

function mapText(color, metrics, selector) {
  if (/terminal|code-window|technical-block\s+pre|command-panel\s+pre|command-preview-card\s+pre/i.test(selector)) {
    if (metrics.saturation < 0.16) {
      return withAlpha(metrics.luminance > 0.45 ? "var(--ds-color-terminal-text)" : "var(--ds-color-terminal-muted)", color.a);
    }
  }
  if (/code-block|hljs/i.test(selector) && metrics.saturation < 0.16) {
    return withAlpha(metrics.luminance > 0.68 ? "var(--ds-color-code-muted)" : "var(--ds-color-code-text)", color.a);
  }
  if (metrics.saturation >= 0.16) {
    return withAlpha(familyToken(semanticFamily(metrics.hue), "text"), color.a);
  }
  if (metrics.luminance > 0.72) return withAlpha("var(--ds-color-text-inverse)", color.a);
  if (metrics.luminance < 0.12) return withAlpha("var(--ds-color-text-primary)", color.a);
  if (metrics.luminance < 0.32) return withAlpha("var(--ds-color-text-secondary)", color.a);
  if (metrics.luminance < 0.56) return withAlpha("var(--ds-color-text-tertiary)", color.a);
  return withAlpha("var(--ds-color-text-disabled)", color.a);
}

function mapBackground(color, metrics, selector) {
  if (/terminal/i.test(selector)) {
    const token = metrics.luminance < 0.035 ? "var(--ds-color-terminal-bg)" : "var(--ds-color-terminal-raised)";
    return withAlpha(token, color.a);
  }
  if (/code-window|technical-block\s+pre|command-panel\s+pre|command-preview-card\s+pre/i.test(selector)) {
    return withAlpha("var(--ds-color-terminal-bg)", color.a);
  }
  if (/code-block|hljs/i.test(selector) && metrics.saturation < 0.16) {
    const token = metrics.luminance > 0.93 ? "var(--ds-color-code-raised)" : "var(--ds-color-code-bg)";
    return withAlpha(token, color.a);
  }
  if (metrics.saturation >= 0.13) {
    const family = semanticFamily(metrics.hue);
    const kind = metrics.luminance > 0.46 || color.a < 0.6 ? "soft" : "solid";
    return withAlpha(familyToken(family, kind), color.a);
  }
  let token;
  if (metrics.luminance > 0.985) token = "var(--ds-color-bg-surface)";
  else if (metrics.luminance > 0.945) token = "var(--ds-color-bg-canvas)";
  else if (metrics.luminance > 0.78) token = "var(--ds-color-bg-subtle)";
  else if (metrics.luminance < 0.08) token = "var(--ds-color-bg-inverse)";
  else token = "var(--ds-color-bg-raised)";
  return withAlpha(token, color.a);
}

function mapBorder(color, metrics) {
  if (metrics.saturation >= 0.13) {
    const token = familyToken(semanticFamily(metrics.hue), "solid");
    return withAlpha(`color-mix(in srgb, ${token} 38%, var(--ds-color-border-default))`, color.a);
  }
  const token = metrics.luminance > 0.94
    ? "var(--ds-color-border-subtle)"
    : metrics.luminance > 0.72
      ? "var(--ds-color-border-default)"
      : "var(--ds-color-border-strong)";
  return withAlpha(token, color.a);
}

function mapShadow(color, metrics) {
  if (metrics.saturation >= 0.13) return withAlpha(familyToken(semanticFamily(metrics.hue), "solid"), Math.min(color.a, 0.36));
  const token = metrics.luminance > 0.7 ? "var(--ds-color-highlight)" : "var(--ds-color-shadow)";
  return withAlpha(token, color.a);
}

function darkEquivalent(literal, declaration, selector) {
  const color = parseColor(literal);
  if (!color) return null;
  const metrics = colorMetrics(color);
  const property = declaration.toLowerCase();
  if (property === "color" || property === "fill" || property === "stroke" || property.includes("caret") || property.includes("text-decoration")) {
    return mapText(color, metrics, selector);
  }
  if (property.includes("shadow") || property === "filter") return mapShadow(color, metrics);
  if (property.includes("border") || property.includes("outline")) return mapBorder(color, metrics);
  if (property.includes("background")) return mapBackground(color, metrics, selector);
  return null;
}

const source = await fs.readFile(target, "utf8");
const root = postcss.parse(source, { from: target.pathname });
let migrated = 0;

root.walkDecls((declaration) => {
  if (declaration.prop.startsWith("--") || declaration.value.includes("light-dark(")) return;
  const selector = declaration.parent?.selector ?? "";
  declaration.value = declaration.value.replace(colorPattern, (literal) => {
    const mapped = darkEquivalent(literal, declaration.prop, selector);
    if (!mapped) return literal;
    migrated += 1;
    return `light-dark(${literal}, ${mapped})`;
  });
});

await fs.writeFile(target, root.toString());
process.stdout.write(`Migrated ${migrated} color occurrences in src/styles.css\n`);
