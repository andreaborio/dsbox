#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function requireValue(condition, message, errors) {
  if (!condition) errors.push(message);
}

async function main() {
  if (process.argv.length !== 3 || ["--help", "-h"].includes(process.argv[2])) {
    console.log("Usage: node scripts/validate-release-sbom.mjs <release-sbom.cdx.json>");
    process.exitCode = process.argv.length === 3 ? 0 : 2;
    return;
  }
  const sbomPath = path.resolve(process.argv[2]);
  const [raw, packageText, lockfile, contractText] = await Promise.all([
    readFile(sbomPath, "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "package-lock.json")),
    readFile(path.join(repositoryRoot, "scripts", "macos-package-contract.json"), "utf8")
  ]);
  const packageJson = JSON.parse(packageText);
  const contract = JSON.parse(contractText);
  const sbom = JSON.parse(raw);
  const expectedName = contract.sbom.fileNameTemplate.replace("{version}", packageJson.version);
  const errors = [];
  requireValue(path.basename(sbomPath) === expectedName, `filename must be ${expectedName}`, errors);
  requireValue(sbom.bomFormat === contract.sbom.format, `bomFormat must be ${contract.sbom.format}`, errors);
  requireValue(sbom.specVersion === contract.sbom.specVersion, `specVersion must be ${contract.sbom.specVersion}`, errors);
  requireValue(sbom.version === 1, "CycloneDX document version must be 1", errors);
  requireValue(/^urn:uuid:[0-9a-f-]{36}$/i.test(sbom.serialNumber ?? ""), "serialNumber must be a UUID URN", errors);
  const root = sbom.metadata?.component;
  requireValue(root?.type === contract.sbom.componentType, `root component type must be ${contract.sbom.componentType}`, errors);
  requireValue(root?.name === packageJson.name, `root component name must be ${packageJson.name}`, errors);
  requireValue(root?.version === packageJson.version, `root component version must be ${packageJson.version}`, errors);
  requireValue(root?.["bom-ref"] === `${packageJson.name}@${packageJson.version}`, "root bom-ref must match package name and version", errors);
  requireValue(root?.purl === `pkg:npm/${packageJson.name}@${packageJson.version}`, "root purl must match package name and version", errors);
  requireValue(Array.isArray(sbom.components) && sbom.components.length > 0, "components must be a non-empty array", errors);
  requireValue(Array.isArray(sbom.dependencies) && sbom.dependencies.length > 0, "dependencies must be a non-empty array", errors);

  const lockHash = createHash("sha256").update(lockfile).digest("hex");
  const declaredLockHash = sbom.metadata?.properties?.find((property) => property?.name === "hebrus:package-lock:sha256")?.value;
  requireValue(declaredLockHash === lockHash, "package-lock SHA-256 property does not match the current lockfile", errors);

  const componentRefs = new Set();
  for (const component of sbom.components ?? []) {
    requireValue(typeof component?.["bom-ref"] === "string" && component["bom-ref"].length > 0, "every component must have a bom-ref", errors);
    if (componentRefs.has(component?.["bom-ref"])) errors.push(`duplicate component bom-ref: ${component["bom-ref"]}`);
    componentRefs.add(component?.["bom-ref"]);
  }
  const lock = JSON.parse(lockfile.toString("utf8"));
  const rootLock = lock.packages?.[""] ?? {};
  const lockedRootDependencies = {
    ...(rootLock.dependencies ?? {}),
    ...(rootLock.devDependencies ?? {})
  };
  const componentsByName = new Set((sbom.components ?? []).map((component) => component?.name));
  for (const dependency of Object.keys(lockedRootDependencies).sort()) {
    requireValue(componentsByName.has(dependency), `locked root dependency is missing from SBOM: ${dependency}`, errors);
  }
  requireValue(componentsByName.has("electron"), "SBOM must include the packaged Electron runtime", errors);

  if (errors.length) {
    console.error("Invalid release SBOM:\n" + [...new Set(errors)].map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${expectedName}: ${sbom.bomFormat} ${sbom.specVersion}, ${sbom.components.length} locked components, package-lock ${lockHash}.`);
}

main().catch((error) => {
  console.error(`Invalid release SBOM: ${error.message}`);
  process.exitCode = 1;
});
