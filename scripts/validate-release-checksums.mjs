#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readJson, sha256File, versioned } from "./release-artifact-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function main() {
  if (process.argv.length !== 3 || ["--help", "-h"].includes(process.argv[2])) {
    console.log("Usage: node scripts/validate-release-checksums.mjs <release-directory>");
    process.exitCode = process.argv.length === 3 ? 0 : 2;
    return;
  }
  const releaseDirectory = path.resolve(process.argv[2]);
  const [packageJson, contract] = await Promise.all([
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json"))
  ]);
  const expectedNames = contract.checksums.requiredFileNameTemplates
    .map((template) => versioned(template, packageJson.version))
    .sort();
  const checksumPath = path.join(releaseDirectory, contract.checksums.fileName);
  const raw = await readFile(checksumPath, "utf8");
  const entries = raw.trimEnd().split("\n").map((line) => {
    const match = line.match(/^([a-f0-9]{64}) {2}([^/]+)$/i);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    return { sha256: match[1].toLowerCase(), fileName: match[2] };
  });
  const actualNames = entries.map(({ fileName }) => fileName);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`checksum assets must be exactly: ${expectedNames.join(", ")}`);
  }
  for (const entry of entries) {
    const actual = await sha256File(path.join(releaseDirectory, entry.fileName));
    if (actual !== entry.sha256) throw new Error(`${entry.fileName} SHA-256 mismatch: expected ${entry.sha256}, got ${actual}`);
  }
  console.log(`Validated ${contract.checksums.fileName}: ${entries.length} exact release assets.`);
}

main().catch((error) => {
  console.error(`Invalid release checksums: ${error.message}`);
  process.exitCode = 1;
});
