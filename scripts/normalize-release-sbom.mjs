#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [raw, packageText, lockfile] = await Promise.all([
    stdin(),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "package-lock.json"))
  ]);
  const packageJson = JSON.parse(packageText);
  const sbom = JSON.parse(raw);
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5") {
    throw new Error(`npm sbom returned ${sbom.bomFormat ?? "unknown"} ${sbom.specVersion ?? "unknown"}, expected CycloneDX 1.5`);
  }
  const root = sbom.metadata?.component;
  if (!root || root["bom-ref"] !== `${packageJson.name}@${packageJson.version}`) {
    throw new Error("npm sbom root component does not match package.json");
  }
  // npm derives metadata.component.name from the checkout directory. Normalize
  // that unstable field while retaining npm's lockfile-derived graph.
  root.name = packageJson.name;
  root.type = "application";
  const properties = Array.isArray(sbom.metadata.properties) ? sbom.metadata.properties : [];
  sbom.metadata.properties = properties.filter((property) => property?.name !== "hebrus:package-lock:sha256");
  sbom.metadata.properties.push({
    name: "hebrus:package-lock:sha256",
    value: createHash("sha256").update(lockfile).digest("hex")
  });
  process.stdout.write(`${JSON.stringify(sbom, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`Could not normalize release SBOM: ${error.message}`);
  process.exitCode = 1;
});
