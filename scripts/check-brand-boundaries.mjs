import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "scripts", "brand-boundary.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const excludedDirectories = new Set([".git", "node_modules", "dist", "dist-server", "release", "coverage"]);
const excludedFiles = new Set(["scripts/brand-boundary.json"]);

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const violations = [];
const observed = new Map();
for (const absolute of await filesIn(root)) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (excludedFiles.has(relative)) continue;
  const contents = await readFile(absolute).catch(() => null);
  if (!contents || contents.includes(0)) continue;
  const text = contents.toString("utf8");
  const count = text.split(manifest.legacyLiteral).length - 1;
  if (count === 0) continue;
  observed.set(relative, count);
  const rule = manifest.allowlist[relative];
  if (!rule) violations.push(`${relative}: ${count} unclassified legacy product-name occurrence(s)`);
  else if (count > rule.maxOccurrences) {
    violations.push(`${relative}: ${count} occurrence(s), allowlist maximum is ${rule.maxOccurrences}`);
  }
}

if (violations.length > 0) {
  console.error("Hebrus Studio brand-boundary audit failed:\n" + violations.map((line) => `- ${line}`).join("\n"));
  process.exit(1);
}

const total = [...observed.values()].reduce((sum, count) => sum + count, 0);
console.log(`Hebrus Studio brand boundary verified: ${total} legacy occurrence(s) in ${observed.size} classified file(s).`);
