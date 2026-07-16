#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";

const root = path.resolve("src");
const colorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const paletteSources = new Set([
  path.resolve("src/design-system/tokens.css"),
  path.resolve("src/design-system/themes.css"),
  path.resolve("src/theme/registry.ts")
]);

async function filesUnder(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target));
    else files.push(target);
  }
  return files;
}

const failures = [];
for (const file of await filesUnder(root)) {
  if (paletteSources.has(file) || file.includes(`${path.sep}assets${path.sep}`)) continue;
  const extension = path.extname(file);
  if (![".css", ".ts", ".tsx"].includes(extension)) continue;
  const source = await fs.readFile(file, "utf8");

  if (file.endsWith(`${path.sep}styles.css`)) {
    const stylesheet = postcss.parse(source, { from: file });
    stylesheet.walkDecls((declaration) => {
      if (!colorPattern.test(declaration.value)) return;
      colorPattern.lastIndex = 0;
      if (!declaration.value.includes("light-dark(")) {
        failures.push(`${path.relative(process.cwd(), file)}:${declaration.source?.start?.line ?? 0} ${declaration.prop}`);
      }
    });
    continue;
  }

  source.split("\n").forEach((line, index) => {
    colorPattern.lastIndex = 0;
    if (colorPattern.test(line)) failures.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
  });
}

if (failures.length) {
  process.stderr.write(`Theme guard found raw colors outside palette sources:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Theme color guard passed\n");
}
