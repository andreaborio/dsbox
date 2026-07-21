#!/usr/bin/env node

import path from "node:path";
import {
  readJson,
  sha256Buffer,
  sha256File,
  validateReleaseProvenance,
  versioned
} from "./release-artifact-utils.mjs";
import { readFile } from "node:fs/promises";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = { report: "" };
  const named = new Set(["dmg", "sbom", "log", "provenance", "expected-commit", "expected-tag"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) {
      console.log("Usage: node scripts/validate-upgrade-rollback-report.mjs <report.json> --dmg <dmg> --sbom <sbom> --log <log> --provenance <json> --expected-commit <commit> --expected-tag <tag>");
      process.exit(0);
    } else if (argument.startsWith("--") && named.has(argument.slice(2))) {
      options[argument.slice(2)] = argv[++index] || "";
    } else if (!options.report) options.report = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  for (const key of ["report", ...named]) if (!options[key]) throw new Error(`missing ${key === "report" ? "report path" : `--${key}`}`);
  for (const key of ["report", "dmg", "sbom", "log", "provenance"]) options[key] = path.resolve(options[key]);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [report, packageJson, contract, provenance, provenanceBytes] = await Promise.all([
    readJson(options.report),
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json")),
    readJson(options.provenance),
    readFile(options.provenance)
  ]);
  validateReleaseProvenance(provenance, {
    packageJson,
    contract,
    expectedCommit: options["expected-commit"],
    expectedTag: options["expected-tag"]
  });
  const expectedReport = versioned(contract.upgradeRollback.reportFileNameTemplate, packageJson.version);
  const expectedLog = versioned(contract.upgradeRollback.logFileNameTemplate, packageJson.version);
  const expectedSbom = versioned(contract.sbom.fileNameTemplate, packageJson.version);
  const expectedDmg = `${contract.artifactBaseName}-${packageJson.version}-macOS-${contract.architecture}.dmg`;
  const errors = [];
  const requireValue = (condition, message) => {
    if (!condition) errors.push(message);
  };
  requireValue(path.basename(options.report) === expectedReport, `report filename must be ${expectedReport}`);
  requireValue(path.basename(options.log) === expectedLog, `log filename must be ${expectedLog}`);
  requireValue(path.basename(options.sbom) === expectedSbom, `SBOM filename must be ${expectedSbom}`);
  requireValue(path.basename(options.dmg) === expectedDmg, `DMG filename must be ${expectedDmg}`);
  requireValue(report.schemaVersion === contract.upgradeRollback.schemaVersion, `schemaVersion must be ${contract.upgradeRollback.schemaVersion}`);
  requireValue(report.result === "pass", "E2E result must be pass");
  requireValue(report.product?.name === contract.productName, `product.name must be ${contract.productName}`);
  requireValue(report.product?.version === packageJson.version, `product.version must be ${packageJson.version}`);
  requireValue(report.product?.bundleIdentifier === contract.bundleIdentifier, `bundleIdentifier must be ${contract.bundleIdentifier}`);
  requireValue(report.product?.architecture === contract.architecture, `architecture must be ${contract.architecture}`);
  requireValue(report.source?.commit === provenance.source.commit, "report source commit does not match provenance");
  requireValue(report.source?.tag === provenance.source.tag, "report source tag does not match provenance");
  requireValue(report.source?.provenanceSha256 === sha256Buffer(provenanceBytes), "report provenance SHA-256 does not match provenance");
  requireValue(report.compatibility?.legacyCommit === contract.upgradeRollback.legacyCommit, "legacy commit does not match the frozen contract");
  requireValue(JSON.stringify(report.compatibility?.sequence) === JSON.stringify(["legacy-create", "hebrus-upgrade", "legacy-rollback"]), "upgrade/rollback sequence is incomplete");
  requireValue(report.compatibility?.processExclusive === true, "E2E must be process-exclusive");
  requireValue(report.compatibility?.modelInferenceStarted === false, "E2E must not start model inference");
  requireValue(report.artifacts?.dmg?.fileName === expectedDmg, "report DMG filename mismatch");
  requireValue(report.artifacts?.sbom?.fileName === expectedSbom, "report SBOM filename mismatch");
  requireValue(report.artifacts?.log?.fileName === expectedLog, "report log filename mismatch");
  requireValue(report.artifacts?.dmg?.sha256 === await sha256File(options.dmg), "report DMG SHA-256 mismatch");
  requireValue(report.artifacts?.sbom?.sha256 === await sha256File(options.sbom), "report SBOM SHA-256 mismatch");
  requireValue(report.artifacts?.log?.sha256 === await sha256File(options.log), "report log SHA-256 mismatch");
  if (errors.length) {
    console.error("Invalid upgrade/rollback report:\n" + [...new Set(errors)].map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${expectedReport}: final DMG ${report.artifacts.dmg.sha256}, source ${report.source.commit}, legacy ${report.compatibility.legacyCommit}.`);
}

main().catch((error) => {
  console.error(`Invalid upgrade/rollback report: ${error.message}`);
  process.exitCode = 1;
});
