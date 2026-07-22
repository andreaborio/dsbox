#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  cycloneDxLicenseExpression,
  lockComponentRef,
  lockDependencyGraph,
  packageNameFromLockPath,
  readJson,
  sha256Buffer,
  validateReleaseProvenance,
  versioned
} from "./release-artifact-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function requireValue(condition, message, errors) {
  if (!condition) errors.push(message);
}

function parseArgs(argv) {
  const options = { sbomPath: "", provenancePath: "", attestationPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--provenance") options.provenancePath = path.resolve(argv[++index] || "");
    else if (argument === "--attestation") options.attestationPath = path.resolve(argv[++index] || "");
    else if (["--help", "-h"].includes(argument)) {
      console.log("Usage: node scripts/validate-release-sbom.mjs <release-sbom.cdx.json> --provenance <release-provenance.json> --attestation <release-attestation.json>");
      process.exit(0);
    } else if (!options.sbomPath) options.sbomPath = path.resolve(argument);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.sbomPath || !options.provenancePath || !options.attestationPath) throw new Error("SBOM path, --provenance, and --attestation are required");
  return options;
}

async function main() {
  const { sbomPath, provenancePath, attestationPath } = parseArgs(process.argv.slice(2));
  const [raw, packageText, lockfile, contract, provenance, provenanceBytes, attestationBytes] = await Promise.all([
    readFile(sbomPath, "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "package-lock.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json")),
    readJson(provenancePath),
    readFile(provenancePath),
    readFile(attestationPath)
  ]);
  const packageJson = JSON.parse(packageText);
  const lock = JSON.parse(lockfile.toString("utf8"));
  validateReleaseProvenance(provenance, { packageJson, contract });
  const sbom = JSON.parse(raw);
  const expectedName = versioned(contract.sbom.fileNameTemplate, packageJson.version);
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

  const metadataProperties = new Map((sbom.metadata?.properties ?? []).map((property) => [property?.name, property?.value]));
  const lockHash = sha256Buffer(lockfile);
  requireValue(metadataProperties.get("hebrus:package-lock:sha256") === lockHash, "package-lock SHA-256 property does not match the current lockfile", errors);
  requireValue(metadataProperties.get("hebrus:source-commit") === provenance.source.commit, "SBOM source commit does not match release provenance", errors);
  requireValue(metadataProperties.get("hebrus:source-tag") === provenance.source.tag, "SBOM source tag does not match release provenance", errors);
  requireValue(metadataProperties.get("hebrus:release-provenance:sha256") === sha256Buffer(provenanceBytes), "SBOM provenance SHA-256 does not match release provenance", errors);
  requireValue(metadataProperties.get("hebrus:release-attestation:sha256") === sha256Buffer(attestationBytes), "SBOM release-attestation SHA-256 does not match release evidence", errors);
  requireValue(/^\d+$/.test(metadataProperties.get("hebrus:license-components-enriched") ?? ""), "SBOM license enrichment count is missing", errors);

  const componentRefs = new Set();
  const componentPaths = new Set();
  for (const component of sbom.components ?? []) {
    const coordinate = `${component?.name ?? "<unknown>"}@${component?.version ?? "<unknown>"}`;
    requireValue(typeof component?.["bom-ref"] === "string" && component["bom-ref"].length > 0, "every component must have a bom-ref", errors);
    if (componentRefs.has(component?.["bom-ref"])) errors.push(`duplicate component bom-ref: ${component["bom-ref"]}`);
    componentRefs.add(component?.["bom-ref"]);
    const lockPaths = (component?.properties ?? [])
      .filter((property) => property?.name === "hebrus:package-lock:path")
      .map((property) => property?.value);
    requireValue(lockPaths.length === 1, `${coordinate} must have exactly one package-lock path`, errors);
    const lockPath = lockPaths[0];
    if (componentPaths.has(lockPath)) errors.push(`duplicate package-lock path: ${lockPath}`);
    componentPaths.add(lockPath);
    const lockMetadata = lock.packages?.[lockPath];
    requireValue(Boolean(lockMetadata), `component references unknown package-lock path: ${lockPath}`, errors);
    if (lockMetadata) {
      requireValue(component.name === packageNameFromLockPath(lockPath), `${lockPath} component name mismatch`, errors);
      requireValue(component.version === lockMetadata.version, `${lockPath} component version mismatch`, errors);
      requireValue(component["bom-ref"] === lockComponentRef(lockPath), `${lockPath} component bom-ref mismatch`, errors);
    }
    if (!Array.isArray(component?.licenses) || component.licenses.length === 0) {
      errors.push(`${coordinate} has no license metadata`);
    } else {
      component.licenses.forEach((license, index) => {
        try {
          cycloneDxLicenseExpression(license, `${coordinate} license[${index}]`);
        } catch (error) {
          errors.push(error.message);
        }
      });
    }
  }
  const expectedPaths = Object.keys(lock.packages ?? {}).filter(Boolean).sort();
  const actualPaths = [...componentPaths].sort();
  requireValue(JSON.stringify(actualPaths) === JSON.stringify(expectedPaths), "SBOM component package-lock paths do not exactly match package-lock.json", errors);
  const expectedGraph = lockDependencyGraph(lock, root?.["bom-ref"]);
  const expectedNodes = new Map(expectedGraph.map((dependency) => [dependency.ref, dependency.dependsOn]));
  const actualNodes = new Map();
  for (const dependency of sbom.dependencies ?? []) {
    requireValue(typeof dependency?.ref === "string" && dependency.ref.length > 0, "every dependency node must have a ref", errors);
    if (actualNodes.has(dependency?.ref)) errors.push(`duplicate dependency ref: ${dependency.ref}`);
    const dependsOn = Array.isArray(dependency?.dependsOn) ? [...dependency.dependsOn].sort() : [];
    actualNodes.set(dependency?.ref, dependsOn);
    for (const ref of dependsOn) requireValue(ref === root?.["bom-ref"] || componentRefs.has(ref), `dependency graph references unknown component: ${ref}`, errors);
  }
  requireValue(JSON.stringify([...actualNodes.keys()].sort()) === JSON.stringify([...expectedNodes.keys()].sort()), "SBOM dependency nodes do not exactly match package-lock.json", errors);
  for (const [ref, dependsOn] of expectedNodes) {
    requireValue(JSON.stringify(actualNodes.get(ref)) === JSON.stringify(dependsOn), `dependency edges do not match package-lock.json for ${ref}`, errors);
  }
  requireValue((sbom.components ?? []).some((component) => component?.name === "electron"), "SBOM must include the packaged Electron runtime", errors);

  if (errors.length) {
    console.error("Invalid release SBOM:\n" + [...new Set(errors)].map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${expectedName}: ${sbom.bomFormat} ${sbom.specVersion}, ${sbom.components.length} locked components with identifiable licenses, package-lock ${lockHash}, source ${provenance.source.commit}.`);
}

main().catch((error) => {
  console.error(`Invalid release SBOM: ${error.message}`);
  process.exitCode = 1;
});
