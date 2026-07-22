#!/usr/bin/env node

import path from "node:path";
import {
  readJson,
  sha256File,
  validateReleaseAttestation,
  validateReleaseProvenance,
  versioned
} from "./release-artifact-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = { attestation: "" };
  const names = new Set(["dmg", "provenance", "expected-commit", "expected-tag"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) {
      console.log("Usage: node scripts/validate-release-attestation.mjs <attestation.json> --dmg <dmg> --provenance <json> --expected-commit <commit> --expected-tag <tag>");
      process.exit(0);
    }
    if (argument.startsWith("--") && names.has(argument.slice(2))) options[argument.slice(2)] = argv[++index] || "";
    else if (!options.attestation) options.attestation = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  for (const name of ["attestation", ...names]) if (!options[name]) throw new Error(`Missing ${name === "attestation" ? "attestation path" : `--${name}`}`);
  for (const name of ["attestation", "dmg", "provenance"]) options[name] = path.resolve(options[name]);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [attestation, packageJson, contract, provenance, provenanceSha256, dmgSha256] = await Promise.all([
    readJson(options.attestation),
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json")),
    readJson(options.provenance),
    sha256File(options.provenance),
    sha256File(options.dmg)
  ]);
  const expectedName = versioned(contract.releaseAttestation.fileNameTemplate, packageJson.version);
  if (path.basename(options.attestation) !== expectedName) throw new Error(`attestation filename must be ${expectedName}`);
  validateReleaseProvenance(provenance, {
    packageJson,
    contract,
    expectedCommit: options["expected-commit"],
    expectedTag: options["expected-tag"]
  });
  validateReleaseAttestation(attestation, {
    packageJson,
    contract,
    provenance,
    provenanceSha256,
    dmgSha256,
    expectedCommit: options["expected-commit"],
    expectedTag: options["expected-tag"]
  });
  console.log(`Validated ${expectedName}: ${attestation.signing.application.certificateCommonName}, notary submission ${attestation.notarization.submissionId}.`);
}

main().catch((error) => {
  console.error(`Invalid release attestation: ${error.message}`);
  process.exitCode = 1;
});
