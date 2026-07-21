#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./release-artifact-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputPath = path.join(repositoryRoot, "build", "release-provenance.json");

async function main() {
  const packageJson = await readJson(path.join(repositoryRoot, "package.json"));
  const commit = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await writeJsonAtomic(outputPath, {
    schemaVersion: 1,
    subject: {
      name: "Hebrus Studio",
      packageName: packageJson.name,
      version: packageJson.version,
      platform: "macOS",
      architecture: "arm64"
    },
    source: { commit, tag: null, treeState: "development" },
    build: { provider: "local-development", workflow: "local-development" }
  });
  console.log(`Generated non-release development provenance for ${commit}.`);
}

main().catch((error) => {
  console.error(`Could not generate development provenance: ${error.message}`);
  process.exitCode = 1;
});
