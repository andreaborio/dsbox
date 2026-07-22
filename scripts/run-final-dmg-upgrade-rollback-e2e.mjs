#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  readJson,
  sha256Buffer,
  sha256File,
  validateReleaseAttestation,
  validateReleaseProvenance,
  versioned,
  writeJsonAtomic,
  writeTextAtomic
} from "./release-artifact-utils.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

function usage() {
  return [
    "Usage: node scripts/run-final-dmg-upgrade-rollback-e2e.mjs",
    "  --old-app /path/to/legacy.app --old-commit <commit>",
    "  --dmg /path/to/final.dmg --attestation /path/to/release-attestation.json --sbom /path/to/final.cdx.json",
    "  --expected-commit <commit> --expected-tag <tag>",
    "  --report /path/to/report.json --log /path/to/e2e.log",
    "  [--old-build-log /path/to/build.log]"
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  const names = new Set([
    "old-app", "old-commit", "dmg", "attestation", "sbom", "expected-commit", "expected-tag",
    "report", "log", "old-build-log"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) {
      console.log(usage());
      process.exit(0);
    }
    if (!argument.startsWith("--") || !names.has(argument.slice(2))) throw new Error(`Unknown argument: ${argument}`);
    options[argument.slice(2)] = argv[++index] || "";
  }
  for (const name of [...names].filter((name) => name !== "old-build-log")) {
    if (!options[name]) throw new Error(`${usage()}\n\nMissing --${name}`);
  }
  for (const name of ["old-app", "dmg", "attestation", "sbom", "report", "log", "old-build-log"]) {
    if (options[name]) options[name] = path.resolve(options[name]);
  }
  if (!/^[a-f0-9]{40}$/i.test(options["old-commit"])) throw new Error("--old-commit must be a full commit id");
  if (!/^[a-f0-9]{40}$/i.test(options["expected-commit"])) throw new Error("--expected-commit must be a full commit id");
  return options;
}

async function plist(appPath, key) {
  const { stdout } = await execFile("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(appPath, "Contents", "Info.plist")]);
  return stdout.trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [packageJson, contract] = await Promise.all([
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(repositoryRoot, "scripts", "macos-package-contract.json"))
  ]);
  const expectedReport = versioned(contract.upgradeRollback.reportFileNameTemplate, packageJson.version);
  const expectedLog = versioned(contract.upgradeRollback.logFileNameTemplate, packageJson.version);
  const expectedDmg = `${contract.artifactBaseName}-${packageJson.version}-macOS-${contract.architecture}.dmg`;
  const expectedSbom = versioned(contract.sbom.fileNameTemplate, packageJson.version);
  const expectedAttestation = versioned(contract.releaseAttestation.fileNameTemplate, packageJson.version);
  if (path.basename(options.report) !== expectedReport) throw new Error(`report filename must be ${expectedReport}`);
  if (path.basename(options.log) !== expectedLog) throw new Error(`log filename must be ${expectedLog}`);
  if (path.basename(options.dmg) !== expectedDmg) throw new Error(`DMG filename must be ${expectedDmg}`);
  if (path.basename(options.sbom) !== expectedSbom) throw new Error(`SBOM filename must be ${expectedSbom}`);
  if (path.basename(options.attestation) !== expectedAttestation) throw new Error(`attestation filename must be ${expectedAttestation}`);
  if (options["old-commit"] !== contract.upgradeRollback.legacyCommit) {
    throw new Error(`legacy commit must be ${contract.upgradeRollback.legacyCommit}`);
  }

  const startedAt = new Date().toISOString();
  const mountDirectory = await mkdtemp(path.join(os.tmpdir(), "hebrus-final-dmg-e2e."));
  const logSections = [];
  let attached = false;
  let report = null;
  try {
    await execFile("hdiutil", ["verify", options.dmg], { maxBuffer: 16 * 1024 * 1024 });
    await execFile("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountDirectory, options.dmg], { maxBuffer: 16 * 1024 * 1024 });
    attached = true;
    const appPath = path.join(mountDirectory, `${contract.productName}.app`);
    const provenancePath = path.join(appPath, "Contents", "Resources", contract.provenance.embeddedFile);
    const [provenanceBytes, provenance, attestationBytes, attestation, sbom, oldBuildLog, dmgHash] = await Promise.all([
      readFile(provenancePath),
      readJson(provenancePath),
      readFile(options.attestation),
      readJson(options.attestation),
      readJson(options.sbom),
      options["old-build-log"] ? readFile(options["old-build-log"], "utf8") : "",
      sha256File(options.dmg)
    ]);
    validateReleaseProvenance(provenance, {
      packageJson,
      contract,
      expectedCommit: options["expected-commit"],
      expectedTag: options["expected-tag"]
    });
    const provenanceHash = sha256Buffer(provenanceBytes);
    validateReleaseAttestation(attestation, {
      packageJson,
      contract,
      provenance,
      provenanceSha256: provenanceHash,
      dmgSha256: dmgHash,
      expectedCommit: options["expected-commit"],
      expectedTag: options["expected-tag"]
    });
    const sbomProperties = new Map((sbom.metadata?.properties ?? []).map((property) => [property?.name, property?.value]));
    if (sbomProperties.get("hebrus:source-commit") !== provenance.source.commit) throw new Error("SBOM source commit does not match the packaged provenance");
    if (sbomProperties.get("hebrus:source-tag") !== provenance.source.tag) throw new Error("SBOM source tag does not match the packaged provenance");
    if (sbomProperties.get("hebrus:release-provenance:sha256") !== provenanceHash) throw new Error("SBOM provenance hash does not match the packaged provenance");
    if (sbomProperties.get("hebrus:release-attestation:sha256") !== sha256Buffer(attestationBytes)) throw new Error("SBOM release-attestation hash does not match release evidence");

    if (oldBuildLog) logSections.push("--- frozen legacy package build ---\n" + oldBuildLog.trimEnd());
    let verification;
    try {
      verification = await execFile(process.execPath, [
        path.join(repositoryRoot, "scripts", "verify-upgrade-rollback-e2e.mjs"),
        "--old-app", options["old-app"],
        "--new-app", appPath
      ], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      if (error?.stdout) logSections.push("--- failed final DMG packaged sequence stdout ---\n" + String(error.stdout).trimEnd());
      if (error?.stderr) logSections.push("--- failed final DMG packaged sequence stderr ---\n" + String(error.stderr).trimEnd());
      throw error;
    }
    logSections.push("--- final DMG packaged sequence ---\n" + verification.stdout.trimEnd());
    if (verification.stderr.trim()) logSections.push("--- verifier stderr ---\n" + verification.stderr.trimEnd());

    const logHeader = [
      "Hebrus Studio final-DMG upgrade/rollback evidence",
      "result=PASS",
      `source_commit=${provenance.source.commit}`,
      `source_tag=${provenance.source.tag}`,
      `legacy_commit=${options["old-commit"]}`,
      `dmg=${path.basename(options.dmg)}`,
      ""
    ].join("\n");
    const logContents = `${logHeader}${logSections.join("\n\n")}\n`;
    await writeTextAtomic(options.log, logContents);
    report = {
      schemaVersion: contract.upgradeRollback.schemaVersion,
      result: "pass",
      startedAt,
      completedAt: new Date().toISOString(),
      product: {
        name: contract.productName,
        version: packageJson.version,
        bundleIdentifier: await plist(appPath, "CFBundleIdentifier"),
        architecture: contract.architecture
      },
      source: {
        commit: provenance.source.commit,
        tag: provenance.source.tag,
        provenanceSha256: provenanceHash
      },
      artifacts: {
        dmg: { fileName: path.basename(options.dmg), sha256: dmgHash },
        attestation: { fileName: path.basename(options.attestation), sha256: sha256Buffer(attestationBytes) },
        sbom: { fileName: path.basename(options.sbom), sha256: await sha256File(options.sbom) },
        log: { fileName: path.basename(options.log), sha256: sha256Buffer(Buffer.from(logContents)) },
        packagedAppPath: `${contract.productName}.app`
      },
      release: {
        signingIdentity: attestation.signing.application.certificateCommonName,
        signingCertificateSha1: attestation.signing.application.certificateSha1,
        teamIdentifier: attestation.signing.application.teamIdentifier,
        notarySubmissionId: attestation.notarization.submissionId
      },
      compatibility: {
        legacyCommit: options["old-commit"],
        sequence: ["legacy-create", "hebrus-upgrade", "legacy-rollback"],
        processExclusive: true,
        modelInferenceStarted: false,
        preservedContracts: [
          "bundle-identity",
          "legacy-electron-profile",
          "runtime-config",
          "model-inventory",
          "download-state",
          "browser-storage"
        ]
      }
    };
    await writeJsonAtomic(options.report, report);
    console.log(`PASS: final DMG upgrade/rollback report written to ${options.report}`);
  } catch (error) {
    const failureLog = [
      "Hebrus Studio final-DMG upgrade/rollback evidence",
      "result=FAIL",
      `error=${String(error?.message ?? error).replaceAll("\n", " | ")}`,
      "",
      ...logSections,
      ""
    ].join("\n");
    await writeTextAtomic(options.log, failureLog).catch(() => {});
    await writeJsonAtomic(options.report, {
      schemaVersion: contract.upgradeRollback.schemaVersion,
      result: "fail",
      startedAt,
      completedAt: new Date().toISOString(),
      error: String(error?.message ?? error)
    }).catch(() => {});
    throw error;
  } finally {
    if (attached) await execFile("hdiutil", ["detach", mountDirectory, "-quiet"]).catch(() => {});
    await rm(mountDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Final-DMG upgrade/rollback E2E failed: ${error.message}`);
  process.exitCode = 1;
});
