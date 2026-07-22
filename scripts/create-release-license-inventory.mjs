#!/usr/bin/env node

import path from "node:path";
import {
  cycloneDxLicenseExpression,
  readJson,
  versioned,
  writeTextAtomic
} from "./release-artifact-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function escaped(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function scopeOf(component) {
  return component.properties?.some((property) => (
    property?.name === "cdx:npm:package:development" && property?.value === "true"
  )) ? "development" : "required";
}

async function main() {
  if (process.argv.length !== 4 || ["--help", "-h"].includes(process.argv[2])) {
    console.log("Usage: node scripts/create-release-license-inventory.mjs <release-sbom.cdx.json> <output.md>");
    process.exitCode = process.argv.length === 3 ? 0 : 2;
    return;
  }
  const sbomPath = path.resolve(process.argv[2]);
  const outputPath = path.resolve(process.argv[3]);
  const [sbom, packageJson, contract] = await Promise.all([
    readJson(sbomPath),
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json"))
  ]);
  const expectedName = versioned(contract.sbom.licenseInventoryFileNameTemplate, packageJson.version);
  if (path.basename(outputPath) !== expectedName) throw new Error(`output filename must be ${expectedName}`);
  if (!Array.isArray(sbom.components) || !sbom.components.length) throw new Error("SBOM has no components");
  const rows = sbom.components.map((component) => {
    if (!Array.isArray(component.licenses) || !component.licenses.length) {
      throw new Error(`${component.name}@${component.version} has no license metadata`);
    }
    const licenses = component.licenses.map((license, index) => (
      cycloneDxLicenseExpression(license, `${component.name}@${component.version} license[${index}]`)
    )).join(" OR ");
    const lockPath = component.properties?.find((property) => property?.name === "hebrus:package-lock:path")?.value;
    if (typeof lockPath !== "string" || !lockPath) throw new Error(`${component.name}@${component.version} has no package-lock path`);
    return {
      name: component.name,
      version: component.version,
      lockPath,
      scope: scopeOf(component),
      licenses,
      purl: component.purl
    };
  }).sort((left, right) => (
    left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version)
    || String(left.lockPath).localeCompare(String(right.lockPath))
    || String(left.purl).localeCompare(String(right.purl))
  ));
  const sourceCommit = sbom.metadata?.properties?.find((property) => property?.name === "hebrus:source-commit")?.value;
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit ?? "")) throw new Error("SBOM source commit is missing");
  const lines = [
    `# Hebrus Studio ${packageJson.version} third-party license inventory`,
    "",
    `Generated from the validated CycloneDX SBOM for source commit \`${sourceCommit}\`.`,
    "This inventory reports package metadata; the bundled notice files remain authoritative where required.",
    "",
    "| Component | Version | Locked path | Scope | SPDX license | Package URL |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${escaped(row.name)} | ${escaped(row.version)} | ${escaped(row.lockPath)} | ${row.scope} | ${escaped(row.licenses)} | ${escaped(row.purl)} |`),
    ""
  ];
  await writeTextAtomic(outputPath, lines.join("\n"));
  console.log(`Created ${expectedName} with ${rows.length} licensed components.`);
}

main().catch((error) => {
  console.error(`Could not create release license inventory: ${error.message}`);
  process.exitCode = 1;
});
