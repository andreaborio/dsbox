#!/usr/bin/env node

import { stat } from "node:fs/promises";
import path from "node:path";
import { readJson, sha256File, versioned, writeTextAtomic } from "./release-artifact-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function main() {
  if (process.argv.length !== 3 || ["--help", "-h"].includes(process.argv[2])) {
    console.log("Usage: node scripts/create-release-checksums.mjs <release-directory>");
    process.exitCode = process.argv.length === 3 ? 0 : 2;
    return;
  }
  const releaseDirectory = path.resolve(process.argv[2]);
  const [packageJson, contract] = await Promise.all([
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json"))
  ]);
  const fileNames = contract.checksums.requiredFileNameTemplates
    .map((template) => versioned(template, packageJson.version))
    .sort();
  const lines = [];
  for (const fileName of fileNames) {
    const filePath = path.join(releaseDirectory, fileName);
    if (!(await stat(filePath)).isFile()) throw new Error(`required checksum asset is not a file: ${fileName}`);
    lines.push(`${await sha256File(filePath)}  ${fileName}`);
  }
  const outputPath = path.join(releaseDirectory, contract.checksums.fileName);
  await writeTextAtomic(outputPath, `${lines.join("\n")}\n`);
  console.log(`Created ${contract.checksums.fileName} for ${fileNames.length} release assets.`);
}

main().catch((error) => {
  console.error(`Could not create release checksums: ${error.message}`);
  process.exitCode = 1;
});
