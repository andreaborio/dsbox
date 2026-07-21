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
  validateDevelopmentProvenance,
  versioned,
  writeJsonAtomic,
  writeTextAtomic
} from "./release-artifact-utils.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

function usage() {
  return [
    "Usage: node scripts/run-development-dmg-upgrade-rollback-e2e.mjs",
    "  --old-app /path/to/legacy.app --old-commit <commit>",
    "  --dmg /path/to/development.dmg --expected-commit <commit>",
    "  --report /path/to/development-report.json --log /path/to/development.log",
    "  [--old-build-log /path/to/build.log]"
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  const names = new Set([
    "old-app", "old-commit", "dmg", "expected-commit", "report", "log", "old-build-log"
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
  for (const name of ["old-app", "dmg", "report", "log", "old-build-log"]) {
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
  const evidenceDirectory = path.join(repositoryRoot, "release", contract.developmentEvidence.directory);
  const expectedReport = versioned(contract.developmentEvidence.reportFileNameTemplate, packageJson.version);
  const expectedLog = versioned(contract.developmentEvidence.logFileNameTemplate, packageJson.version);
  const expectedDmg = `${contract.artifactBaseName}-${packageJson.version}-macOS-${contract.architecture}.dmg`;
  if (path.dirname(options.report) !== evidenceDirectory || path.basename(options.report) !== expectedReport) {
    throw new Error(`development report must be ${path.join(evidenceDirectory, expectedReport)}`);
  }
  if (path.dirname(options.log) !== evidenceDirectory || path.basename(options.log) !== expectedLog) {
    throw new Error(`development log must be ${path.join(evidenceDirectory, expectedLog)}`);
  }
  if (path.basename(options.dmg) !== expectedDmg) throw new Error(`DMG filename must be ${expectedDmg}`);
  if (options["old-commit"] !== contract.upgradeRollback.legacyCommit) {
    throw new Error(`legacy commit must be ${contract.upgradeRollback.legacyCommit}`);
  }

  const startedAt = new Date().toISOString();
  const mountDirectory = await mkdtemp(path.join(os.tmpdir(), "hebrus-development-dmg-e2e."));
  const logSections = [];
  let attached = false;
  try {
    await execFile("hdiutil", ["verify", options.dmg], { maxBuffer: 16 * 1024 * 1024 });
    await execFile("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountDirectory, options.dmg], { maxBuffer: 16 * 1024 * 1024 });
    attached = true;
    const appPath = path.join(mountDirectory, `${contract.productName}.app`);
    const provenancePath = path.join(appPath, "Contents", "Resources", contract.provenance.embeddedFile);
    const [provenanceBytes, provenance, oldBuildLog] = await Promise.all([
      readFile(provenancePath),
      readJson(provenancePath),
      options["old-build-log"] ? readFile(options["old-build-log"], "utf8") : ""
    ]);
    validateDevelopmentProvenance(provenance, {
      packageJson,
      contract,
      expectedCommit: options["expected-commit"]
    });
    const provenanceHash = sha256Buffer(provenanceBytes);

    if (oldBuildLog) logSections.push("--- frozen legacy package build ---\n" + oldBuildLog.trimEnd());
    let verification;
    try {
      verification = await execFile(process.execPath, [
        path.join(repositoryRoot, "scripts", "verify-upgrade-rollback-e2e.mjs"),
        "--old-app", options["old-app"],
        "--new-app", appPath
      ], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      if (error?.stdout) logSections.push("--- failed development-DMG packaged sequence stdout ---\n" + String(error.stdout).trimEnd());
      if (error?.stderr) logSections.push("--- failed development-DMG packaged sequence stderr ---\n" + String(error.stderr).trimEnd());
      throw error;
    }
    logSections.push("--- development-DMG packaged sequence ---\n" + verification.stdout.trimEnd());
    if (verification.stderr.trim()) logSections.push("--- verifier stderr ---\n" + verification.stderr.trimEnd());

    const logHeader = [
      "Hebrus Studio development final-DMG upgrade/rollback evidence",
      "qualification=development",
      "release_authorization=false",
      "result=PASS",
      `current_commit=${provenance.source.commit}`,
      "source_tag=null",
      `provenance_sha256=${provenanceHash}`,
      `legacy_commit=${options["old-commit"]}`,
      `dmg=${path.basename(options.dmg)}`,
      ""
    ].join("\n");
    const logContents = `${logHeader}${logSections.join("\n\n")}\n`;
    await writeTextAtomic(options.log, logContents);
    const report = {
      schemaVersion: contract.developmentEvidence.schemaVersion,
      qualification: contract.developmentEvidence.qualification,
      releaseAuthorization: false,
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
        currentCommit: provenance.source.commit,
        tag: null,
        treeState: "development",
        provenanceSha256: provenanceHash
      },
      artifacts: {
        dmg: { fileName: path.basename(options.dmg), sha256: await sha256File(options.dmg) },
        log: { fileName: path.basename(options.log), sha256: sha256Buffer(Buffer.from(logContents)) },
        packagedAppPath: `${contract.productName}.app`
      },
      compatibility: {
        legacyCommit: options["old-commit"],
        currentCommit: provenance.source.commit,
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
    console.log(`PASS: development final-DMG evidence written to ${options.report}`);
  } catch (error) {
    const failureLog = [
      "Hebrus Studio development final-DMG upgrade/rollback evidence",
      "qualification=development",
      "release_authorization=false",
      "result=FAIL",
      `error=${String(error?.message ?? error).replaceAll("\n", " | ")}`,
      "",
      ...logSections,
      ""
    ].join("\n");
    await writeTextAtomic(options.log, failureLog).catch(() => {});
    await writeJsonAtomic(options.report, {
      schemaVersion: contract.developmentEvidence.schemaVersion,
      qualification: contract.developmentEvidence.qualification,
      releaseAuthorization: false,
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
  console.error(`Development final-DMG upgrade/rollback E2E failed: ${error.message}`);
  process.exitCode = 1;
});
