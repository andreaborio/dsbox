#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  cycloneDxLicenseExpression,
  cycloneDxLicensesFromPackageMetadata,
  lockComponentRef,
  lockDependencyGraph,
  packageNameFromLockPath,
  readJson,
  sha256Buffer,
  validateReleaseProvenance
} from "./release-artifact-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  let provenancePath = "";
  let attestationPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--provenance") provenancePath = path.resolve(argv[++index] || "");
    else if (argument === "--attestation") attestationPath = path.resolve(argv[++index] || "");
    else if (["--help", "-h"].includes(argument)) {
      console.log("Usage: npm sbom ... | node scripts/normalize-release-sbom.mjs --provenance <release-provenance.json> --attestation <release-attestation.json>");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!provenancePath || !attestationPath) throw new Error("--provenance and --attestation are required");
  return { provenancePath, attestationPath };
}

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function matchingLockPaths(lock, component) {
  const suffix = `node_modules/${component.name}`;
  return Object.entries(lock.packages ?? {})
    .filter(([packagePath, metadata]) => packagePath.endsWith(suffix) && metadata?.version === component.version)
    .map(([packagePath]) => packagePath)
    .sort();
}

async function installedLicense(component, lock) {
  const candidates = matchingLockPaths(lock, component);
  const found = [];
  for (const packagePath of candidates) {
    try {
      const metadata = await readJson(path.join(repositoryRoot, packagePath, "package.json"));
      const value = metadata.license ?? metadata.licenses;
      if (value !== undefined) found.push({ packagePath, value });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!found.length) {
    throw new Error(`license metadata missing for ${component.name}@${component.version}; checked ${candidates.length || 0} lockfile path(s)`);
  }
  const variants = new Map(found.map(({ value }) => [JSON.stringify(value), value]));
  if (variants.size !== 1) {
    throw new Error(`ambiguous installed license metadata for ${component.name}@${component.version}`);
  }
  return {
    licenses: cycloneDxLicensesFromPackageMetadata([...variants.values()][0], `${component.name}@${component.version} license`),
    sourcePaths: found.map(({ packagePath }) => `${packagePath}/package.json`)
  };
}

async function main() {
  const { provenancePath, attestationPath } = parseArgs(process.argv.slice(2));
  const [raw, packageText, lockfile, contract, provenance, attestationBytes] = await Promise.all([
    stdin(),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "package-lock.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json")),
    readJson(provenancePath),
    readFile(attestationPath)
  ]);
  const packageJson = JSON.parse(packageText);
  const lock = JSON.parse(lockfile.toString("utf8"));
  validateReleaseProvenance(provenance, { packageJson, contract });
  const sbom = JSON.parse(raw);
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5") {
    throw new Error(`npm sbom returned ${sbom.bomFormat ?? "unknown"} ${sbom.specVersion ?? "unknown"}, expected CycloneDX 1.5`);
  }
  const root = sbom.metadata?.component;
  if (!root || root["bom-ref"] !== `${packageJson.name}@${packageJson.version}`) {
    throw new Error("npm sbom root component does not match package.json");
  }

  root.name = packageJson.name;
  root.type = "application";
  let enrichedLicenses = 0;
  for (const component of sbom.components ?? []) {
    if (Array.isArray(component.licenses) && component.licenses.length) {
      component.licenses.forEach((license, index) => cycloneDxLicenseExpression(license, `${component.name}@${component.version} license[${index}]`));
      continue;
    }
    const resolved = await installedLicense(component, lock);
    component.licenses = resolved.licenses;
    const properties = Array.isArray(component.properties) ? component.properties : [];
    component.properties = properties.filter((property) => property?.name !== "hebrus:license-metadata-source");
    component.properties.push({
      name: "hebrus:license-metadata-source",
      value: resolved.sourcePaths.join(",")
    });
    enrichedLicenses += 1;
  }

  const componentsByCoordinate = new Map();
  for (const component of sbom.components ?? []) {
    const key = `${component.name}\u0000${component.version}`;
    if (componentsByCoordinate.has(key)) throw new Error(`npm sbom returned duplicate coordinate ${component.name}@${component.version}`);
    componentsByCoordinate.set(key, component);
  }
  const completeComponents = [];
  for (const packagePath of Object.keys(lock.packages ?? {}).filter(Boolean).sort()) {
    const metadata = lock.packages[packagePath];
    const name = packageNameFromLockPath(packagePath);
    const template = componentsByCoordinate.get(`${name}\u0000${metadata.version}`);
    if (!template) throw new Error(`npm sbom omitted locked coordinate ${name}@${metadata.version} at ${packagePath}`);
    const component = structuredClone(template);
    component["bom-ref"] = lockComponentRef(packagePath);
    const componentProperties = Array.isArray(component.properties) ? component.properties : [];
    component.properties = componentProperties.filter((property) => ![
      "hebrus:package-lock:path",
      "cdx:npm:package:development"
    ].includes(property?.name));
    component.properties.push({ name: "hebrus:package-lock:path", value: packagePath });
    if (metadata.dev === true) component.properties.push({ name: "cdx:npm:package:development", value: "true" });
    completeComponents.push(component);
  }
  sbom.components = completeComponents;
  sbom.dependencies = lockDependencyGraph(lock, root["bom-ref"]);

  const propertyNames = new Set([
    "hebrus:package-lock:sha256",
    "hebrus:source-commit",
    "hebrus:source-tag",
    "hebrus:release-provenance:sha256",
    "hebrus:release-attestation:sha256",
    "hebrus:license-components-enriched"
  ]);
  const properties = Array.isArray(sbom.metadata.properties) ? sbom.metadata.properties : [];
  sbom.metadata.properties = properties.filter((property) => !propertyNames.has(property?.name));
  sbom.metadata.properties.push(
    { name: "hebrus:package-lock:sha256", value: sha256Buffer(lockfile) },
    { name: "hebrus:source-commit", value: provenance.source.commit },
    { name: "hebrus:source-tag", value: provenance.source.tag },
    { name: "hebrus:release-provenance:sha256", value: sha256Buffer(await readFile(provenancePath)) },
    { name: "hebrus:release-attestation:sha256", value: sha256Buffer(attestationBytes) },
    { name: "hebrus:license-components-enriched", value: String(enrichedLicenses) }
  );
  process.stdout.write(`${JSON.stringify(sbom, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`Could not normalize release SBOM: ${error.message}`);
  process.exitCode = 1;
});
