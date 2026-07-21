#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  readJson,
  sha256File,
  validateReleaseAttestation,
  validateReleaseProvenance,
  versioned,
  writeJsonAtomic
} from "./release-artifact-utils.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {};
  const names = new Set(["dmg", "provenance", "notary-json", "output", "expected-commit", "expected-tag"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) {
      console.log("Usage: node scripts/create-release-attestation.mjs --dmg <final.dmg> --provenance <json> --notary-json <json> --output <json> --expected-commit <commit> --expected-tag <tag>");
      process.exit(0);
    }
    if (!argument.startsWith("--") || !names.has(argument.slice(2))) throw new Error(`Unknown argument: ${argument}`);
    options[argument.slice(2)] = argv[++index] || "";
  }
  for (const name of names) if (!options[name]) throw new Error(`Missing --${name}`);
  for (const name of ["dmg", "provenance", "notary-json", "output"]) options[name] = path.resolve(options[name]);
  if (!/^[a-f0-9]{40}$/i.test(options["expected-commit"])) throw new Error("--expected-commit must be a full commit id");
  return options;
}

function expectedSigningFromEnvironment() {
  const signing = {
    certificateCommonName: process.env.HEBRUS_SIGNING_CERTIFICATE_COMMON_NAME ?? "",
    certificateSha1: (process.env.HEBRUS_SIGNING_CERTIFICATE_SHA1 ?? "").toLowerCase(),
    teamIdentifier: process.env.HEBRUS_SIGNING_TEAM_ID ?? ""
  };
  if (!signing.certificateCommonName.startsWith("Developer ID Application:")) throw new Error("HEBRUS_SIGNING_CERTIFICATE_COMMON_NAME is missing or invalid");
  if (!/^[a-f0-9]{40}$/.test(signing.certificateSha1)) throw new Error("HEBRUS_SIGNING_CERTIFICATE_SHA1 is missing or invalid");
  if (!/^[A-Z0-9]{10}$/.test(signing.teamIdentifier)) throw new Error("HEBRUS_SIGNING_TEAM_ID is missing or invalid");
  return signing;
}

async function signingIdentity(target, certificatePrefix) {
  await execFile("codesign", ["--verify", "--verbose=2", target], { maxBuffer: 8 * 1024 * 1024 });
  const detailsResult = await execFile("codesign", ["-dv", "--verbose=4", target], { maxBuffer: 8 * 1024 * 1024 });
  const details = `${detailsResult.stdout}${detailsResult.stderr}`;
  const certificateCommonName = details.match(/^Authority=(Developer ID Application:.*)$/m)?.[1];
  const teamIdentifier = details.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
  if (!certificateCommonName || !teamIdentifier) throw new Error(`Could not extract Developer ID identity from ${target}`);
  await execFile("codesign", ["-d", "--extract-certificates", certificatePrefix, target], { maxBuffer: 8 * 1024 * 1024 });
  const leaf = await readFile(`${certificatePrefix}0`);
  return {
    certificateCommonName,
    certificateSha1: createHash("sha1").update(leaf).digest("hex"),
    teamIdentifier
  };
}

function requireExactIdentity(actual, expected, label) {
  if (actual.certificateCommonName !== expected.certificateCommonName) throw new Error(`${label} certificate common name does not match the protected release identity`);
  if (actual.certificateSha1 !== expected.certificateSha1) throw new Error(`${label} certificate SHA-1 does not match the protected release identity`);
  if (actual.teamIdentifier !== expected.teamIdentifier) throw new Error(`${label} Apple team id does not match the protected release identity`);
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Release attestation creation requires macOS");
  const options = parseArgs(process.argv.slice(2));
  const [packageJson, contract, provenance, notary] = await Promise.all([
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json")),
    readJson(options.provenance),
    readJson(options["notary-json"])
  ]);
  const expectedOutput = versioned(contract.releaseAttestation.fileNameTemplate, packageJson.version);
  const expectedDmg = `${contract.artifactBaseName}-${packageJson.version}-macOS-${contract.architecture}.dmg`;
  if (path.basename(options.output) !== expectedOutput) throw new Error(`output filename must be ${expectedOutput}`);
  if (path.basename(options.dmg) !== expectedDmg) throw new Error(`DMG filename must be ${expectedDmg}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(notary.id ?? "")) throw new Error("notarytool JSON is missing a valid submission id");
  if (notary.status !== "Accepted") throw new Error(`notarytool status must be Accepted, got ${notary.status ?? "<missing>"}`);

  const expectedSigning = expectedSigningFromEnvironment();
  validateReleaseProvenance(provenance, {
    packageJson,
    contract,
    expectedCommit: options["expected-commit"],
    expectedTag: options["expected-tag"],
    expectedSigning
  });

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "hebrus-release-attestation-"));
  const mountDirectory = path.join(temporaryDirectory, "mounted-dmg");
  let attached = false;
  try {
    await mkdir(mountDirectory);
    await execFile("hdiutil", ["verify", options.dmg], { maxBuffer: 16 * 1024 * 1024 });
    const dmgIdentity = await signingIdentity(options.dmg, path.join(temporaryDirectory, "dmg-cert-"));
    requireExactIdentity(dmgIdentity, expectedSigning, "DMG");
    await execFile("xcrun", ["stapler", "validate", options.dmg], { maxBuffer: 8 * 1024 * 1024 });
    await execFile("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountDirectory, options.dmg], { maxBuffer: 16 * 1024 * 1024 });
    attached = true;
    const applicationPath = path.join(mountDirectory, `${contract.productName}.app`);
    const applicationIdentity = await signingIdentity(applicationPath, path.join(temporaryDirectory, "app-cert-"));
    requireExactIdentity(applicationIdentity, expectedSigning, "Application");
    await execFile("codesign", ["--verify", "--deep", "--strict", "--verbose=2", applicationPath], { maxBuffer: 16 * 1024 * 1024 });
    await execFile("spctl", ["--assess", "--type", "execute", "--verbose=4", applicationPath], { maxBuffer: 8 * 1024 * 1024 });

    const [provenanceSha256, dmgSha256] = await Promise.all([
      sha256File(options.provenance),
      sha256File(options.dmg)
    ]);
    const attestation = {
      schemaVersion: contract.releaseAttestation.schemaVersion,
      createdAt: new Date().toISOString(),
      product: {
        name: contract.productName,
        version: packageJson.version,
        architecture: contract.architecture
      },
      source: {
        commit: provenance.source.commit,
        tag: provenance.source.tag
      },
      provenance: {
        fileName: contract.provenance.embeddedFile,
        sha256: provenanceSha256
      },
      artifacts: {
        dmg: { fileName: expectedDmg, sha256: dmgSha256 }
      },
      signing: {
        application: applicationIdentity,
        dmg: dmgIdentity
      },
      notarization: {
        submissionId: notary.id,
        status: notary.status,
        message: typeof notary.message === "string" ? notary.message : null,
        dmgStapled: true,
        applicationGatekeeperAccepted: true
      }
    };
    validateReleaseAttestation(attestation, {
      packageJson,
      contract,
      provenance,
      provenanceSha256,
      dmgSha256,
      expectedCommit: options["expected-commit"],
      expectedTag: options["expected-tag"]
    });
    await writeJsonAtomic(options.output, attestation);
    console.log(`Created ${expectedOutput} for notary submission ${notary.id}.`);
  } finally {
    if (attached) await execFile("hdiutil", ["detach", mountDirectory, "-quiet"]).catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Could not create release attestation: ${error.message}`);
  process.exitCode = 1;
});
