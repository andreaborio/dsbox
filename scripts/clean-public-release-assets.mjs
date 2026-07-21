#!/usr/bin/env node

import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { readJson, versioned } from "./release-artifact-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function main() {
  if (process.argv.length !== 3 || ["--help", "-h"].includes(process.argv[2])) {
    console.log("Usage: node scripts/clean-public-release-assets.mjs <release-directory>");
    process.exitCode = process.argv.length === 3 ? 0 : 2;
    return;
  }
  const releaseDirectory = path.resolve(process.argv[2]);
  const [packageJson, contract] = await Promise.all([
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json"))
  ]);
  const publicFileNames = [
    ...contract.checksums.requiredFileNameTemplates.map((template) => versioned(template, packageJson.version)),
    contract.checksums.fileName
  ].sort();
  const existing = [];
  for (const fileName of publicFileNames) {
    if (fileName !== path.basename(fileName)) throw new Error(`public release asset must be a plain filename: ${fileName}`);
    const filePath = path.join(releaseDirectory, fileName);
    let metadata;
    try {
      metadata = await lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new Error(`refusing to remove non-file public release asset: ${filePath}`);
    }
    existing.push({ fileName, filePath });
  }
  const removed = [];
  for (const { fileName, filePath } of existing) {
    await unlink(filePath);
    removed.push(fileName);
  }
  if (removed.length) console.log(`Removed stale public release assets before development packaging: ${removed.join(", ")}`);
  else console.log("No stale public release assets were present before development packaging.");
}

main().catch((error) => {
  console.error(`Could not clean public release assets: ${error.message}`);
  process.exitCode = 1;
});
