import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const developmentValidator = path.join(repositoryRoot, "scripts", "validate-development-upgrade-rollback-report.mjs");
const releaseValidator = path.join(repositoryRoot, "scripts", "validate-upgrade-rollback-report.mjs");
const temporaryDirectories: string[] = [];
const currentCommit = "a".repeat(40);
const legacyCommit = "595e9952c4fd1197de3aa3ccde66a5ddccddd397";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "hebrus-development-evidence-test-"));
  temporaryDirectories.push(directory);
  const releaseDirectory = path.join(directory, "release");
  const evidenceDirectory = path.join(releaseDirectory, "development-evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const names = {
    dmg: "Hebrus-Studio-0.4.0-macOS-arm64.dmg",
    report: "Hebrus-Studio-0.4.0-Development-Upgrade-Rollback-E2E.json",
    log: "Hebrus-Studio-0.4.0-Development-Upgrade-Rollback-E2E.log"
  };
  const dmg = path.join(releaseDirectory, names.dmg);
  const report = path.join(evidenceDirectory, names.report);
  const log = path.join(evidenceDirectory, names.log);
  const provenance = path.join(directory, "release-provenance.json");
  const dmgText = "development final dmg";
  const logText = "qualification=development\nrelease_authorization=false\nresult=PASS\n";
  const provenanceText = `${JSON.stringify({
    schemaVersion: 1,
    subject: { name: "Hebrus Studio", packageName: "hebrus-studio", version: "0.4.0", platform: "macOS", architecture: "arm64" },
    source: { commit: currentCommit, tag: null, treeState: "development" },
    build: { provider: "local-development", workflow: "local-development" }
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(dmg, dmgText),
    writeFile(log, logText),
    writeFile(provenance, provenanceText)
  ]);
  await writeFile(report, `${JSON.stringify({
    schemaVersion: 1,
    qualification: "development",
    releaseAuthorization: false,
    result: "pass",
    startedAt: "2026-07-22T00:00:00.000Z",
    completedAt: "2026-07-22T00:01:00.000Z",
    product: { name: "Hebrus Studio", version: "0.4.0", bundleIdentifier: "com.dsbox.desktop", architecture: "arm64" },
    source: { currentCommit, tag: null, treeState: "development", provenanceSha256: sha256(provenanceText) },
    artifacts: {
      dmg: { fileName: names.dmg, sha256: sha256(dmgText) },
      log: { fileName: names.log, sha256: sha256(logText) },
      packagedAppPath: "Hebrus Studio.app"
    },
    compatibility: {
      legacyCommit,
      currentCommit,
      sequence: ["legacy-create", "hebrus-upgrade", "legacy-rollback"],
      processExclusive: true,
      modelInferenceStarted: false,
      preservedContracts: ["bundle-identity"]
    }
  }, null, 2)}\n`);
  return { directory, releaseDirectory, evidenceDirectory, names, dmg, report, log, provenance, provenanceText };
}

function validateDevelopment(source: Awaited<ReturnType<typeof fixture>>) {
  return spawnSync(process.execPath, [
    developmentValidator,
    source.report,
    "--dmg", source.dmg,
    "--log", source.log,
    "--provenance", source.provenance,
    "--expected-commit", currentCommit
  ], { cwd: repositoryRoot, encoding: "utf8" });
}

describe("development final-DMG compatibility evidence", () => {
  it("validates development-only evidence bound to the DMG, provenance, log, and commits", async () => {
    const source = await fixture();
    const result = validateDevelopment(source);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("development final DMG");
    expect(result.stdout).toContain(currentCommit);
    expect(result.stdout).toContain(legacyCommit);
  });

  it("rejects tampered development evidence artifacts", async () => {
    const source = await fixture();
    await writeFile(source.log, "tampered log\n");
    const tamperedLog = validateDevelopment(source);
    expect(tamperedLog.status).toBe(1);
    expect(tamperedLog.stderr).toContain("report log SHA-256 mismatch");

    const fresh = await fixture();
    await writeFile(fresh.dmg, "tampered dmg\n");
    const tamperedDmg = validateDevelopment(fresh);
    expect(tamperedDmg.status).toBe(1);
    expect(tamperedDmg.stderr).toContain("report DMG SHA-256 mismatch");
  });

  it("rejects release provenance in the development lane", async () => {
    const source = await fixture();
    const releaseProvenance = JSON.parse(source.provenanceText);
    releaseProvenance.source.tag = "v0.4.0";
    releaseProvenance.source.treeState = "clean";
    releaseProvenance.build = {
      provider: "github-actions",
      workflow: "release-macos",
      event: "push",
      refType: "tag",
      runId: "123",
      runAttempt: "1",
      runnerOs: "macOS",
      runnerArch: "X64",
      githubActions: true
    };
    await writeFile(source.provenance, `${JSON.stringify(releaseProvenance, null, 2)}\n`);
    const result = validateDevelopment(source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source.tag must be null for development provenance");
    expect(result.stderr).toContain("build.provider must be local-development");
  });

  it("rejects development evidence for any commit other than the requested current commit", async () => {
    const source = await fixture();
    const result = spawnSync(process.execPath, [
      developmentValidator,
      source.report,
      "--dmg", source.dmg,
      "--log", source.log,
      "--provenance", source.provenance,
      "--expected-commit", "b".repeat(40)
    ], { cwd: repositoryRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source.commit must equal current commit");
  });

  it("rejects development provenance and report in the release validator", async () => {
    const source = await fixture();
    const sbom = path.join(source.releaseDirectory, "Hebrus-Studio-0.4.0-SBOM.cdx.json");
    await writeFile(sbom, "{}\n");
    const result = spawnSync(process.execPath, [
      releaseValidator,
      source.report,
      "--dmg", source.dmg,
      "--sbom", sbom,
      "--log", source.log,
      "--provenance", source.provenance,
      "--expected-commit", currentCommit,
      "--expected-tag", "v0.4.0"
    ], { cwd: repositoryRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source.tag must be v0.4.0");
    expect(result.stderr).toContain("build.provider must be github-actions");
  });
});
