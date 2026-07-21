import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const reportValidator = path.join(repositoryRoot, "scripts", "validate-upgrade-rollback-report.mjs");
const checksumCreator = path.join(repositoryRoot, "scripts", "create-release-checksums.mjs");
const checksumValidator = path.join(repositoryRoot, "scripts", "validate-release-checksums.mjs");
const temporaryDirectories: string[] = [];
const sourceCommit = "a".repeat(40);
const legacyCommit = "595e9952c4fd1197de3aa3ccde66a5ddccddd397";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "hebrus-release-evidence-test-"));
  temporaryDirectories.push(directory);
  const names = {
    dmg: "Hebrus-Studio-0.4.0-macOS-arm64.dmg",
    attestation: "Hebrus-Studio-0.4.0-Release-Attestation.json",
    sbom: "Hebrus-Studio-0.4.0-SBOM.cdx.json",
    licenses: "Hebrus-Studio-0.4.0-THIRD-PARTY-LICENSES.md",
    report: "Hebrus-Studio-0.4.0-Upgrade-Rollback-E2E.json",
    log: "Hebrus-Studio-0.4.0-Upgrade-Rollback-E2E.log"
  };
  const values = { dmg: "final dmg", sbom: "final sbom", licenses: "license inventory", log: "PASS final DMG sequence\n" };
  await Promise.all(Object.entries(values).map(([key, value]) => writeFile(path.join(directory, names[key as keyof typeof names]), value)));
  const provenancePath = path.join(directory, "release-provenance.json");
  const contract = JSON.parse(await readFile(path.join(repositoryRoot, "scripts", "macos-package-contract.json"), "utf8"));
  const provenanceText = `${JSON.stringify({
    schemaVersion: 2,
    subject: { name: "Hebrus Studio", packageName: "hebrus-studio", version: "0.4.0", platform: "macOS", architecture: "arm64" },
    source: { repository: "andreaborio/hebrus-studio", commit: sourceCommit, tag: "v0.4.0", treeState: "clean" },
    build: { provider: "github-actions", workflow: "release-macos", event: "push", refType: "tag", runId: "123", runAttempt: "1", runnerOs: "macOS", runnerArch: "ARM64", githubActions: true },
    authorization: {
      readinessManifestSha256: "b".repeat(64),
      signing: {
        certificateCommonName: "Developer ID Application: Hebrus Test (ABCDE12345)",
        certificateSha1: "c".repeat(40),
        teamIdentifier: "ABCDE12345"
      },
      notarizationQualificationSubmissionId: "12345678-1234-4234-8234-123456789abc"
    }
  }, null, 2)}\n`;
  await writeFile(provenancePath, provenanceText);
  const attestation = {
    schemaVersion: 1,
    product: { name: "Hebrus Studio", version: "0.4.0", architecture: "arm64" },
    source: { commit: sourceCommit, tag: "v0.4.0" },
    provenance: { fileName: "release-provenance.json", sha256: sha256(provenanceText) },
    artifacts: { dmg: { fileName: names.dmg, sha256: sha256(values.dmg) } },
    signing: {
      application: { certificateCommonName: "Developer ID Application: Hebrus Test (ABCDE12345)", certificateSha1: "c".repeat(40), teamIdentifier: "ABCDE12345" },
      dmg: { certificateCommonName: "Developer ID Application: Hebrus Test (ABCDE12345)", certificateSha1: "c".repeat(40), teamIdentifier: "ABCDE12345" }
    },
    notarization: {
      submissionId: "87654321-4321-4321-8321-cba987654321",
      status: "Accepted",
      dmgStapled: true,
      applicationGatekeeperAccepted: true
    }
  };
  const attestationText = `${JSON.stringify(attestation, null, 2)}\n`;
  await writeFile(path.join(directory, names.attestation), attestationText);
  const report = {
    schemaVersion: 2,
    result: "pass",
    startedAt: "2026-07-21T00:00:00.000Z",
    completedAt: "2026-07-21T00:01:00.000Z",
    product: { name: "Hebrus Studio", version: "0.4.0", bundleIdentifier: contract.bundleIdentifier, architecture: "arm64" },
    source: { commit: sourceCommit, tag: "v0.4.0", provenanceSha256: sha256(provenanceText) },
    artifacts: {
      dmg: { fileName: names.dmg, sha256: sha256(values.dmg) },
      attestation: { fileName: names.attestation, sha256: sha256(attestationText) },
      sbom: { fileName: names.sbom, sha256: sha256(values.sbom) },
      log: { fileName: names.log, sha256: sha256(values.log) },
      packagedAppPath: "Hebrus Studio.app"
    },
    release: {
      signingIdentity: attestation.signing.application.certificateCommonName,
      signingCertificateSha1: attestation.signing.application.certificateSha1,
      teamIdentifier: attestation.signing.application.teamIdentifier,
      notarySubmissionId: attestation.notarization.submissionId
    },
    compatibility: {
      legacyCommit,
      sequence: ["legacy-create", "hebrus-upgrade", "legacy-rollback"],
      processExclusive: true,
      modelInferenceStarted: false,
      preservedContracts: ["bundle-identity"]
    }
  };
  await writeFile(path.join(directory, names.report), `${JSON.stringify(report, null, 2)}\n`);
  return { directory, names, provenancePath };
}

function validateReport(source: Awaited<ReturnType<typeof fixture>>) {
  return spawnSync(process.execPath, [
    reportValidator,
    path.join(source.directory, source.names.report),
    "--dmg", path.join(source.directory, source.names.dmg),
    "--attestation", path.join(source.directory, source.names.attestation),
    "--sbom", path.join(source.directory, source.names.sbom),
    "--log", path.join(source.directory, source.names.log),
    "--provenance", source.provenancePath,
    "--expected-commit", sourceCommit,
    "--expected-tag", "v0.4.0"
  ], { cwd: repositoryRoot, encoding: "utf8" });
}

describe("release artifact evidence", () => {
  it("validates a report bound to the final DMG, SBOM, log, provenance, and commits", async () => {
    const source = await fixture();
    const result = validateReport(source);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(sourceCommit);
    expect(result.stdout).toContain(legacyCommit);
  });

  it("rejects a report after a bound artifact changes", async () => {
    const source = await fixture();
    await writeFile(path.join(source.directory, source.names.log), "tampered\n");
    const result = validateReport(source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("report log SHA-256 mismatch");
  });

  it("rejects an accepted-notary claim whose actual signature identity differs from provenance", async () => {
    const source = await fixture();
    const attestationPath = path.join(source.directory, source.names.attestation);
    const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
    attestation.signing.dmg.certificateSha1 = "f".repeat(40);
    await writeFile(attestationPath, JSON.stringify(attestation));
    const result = validateReport(source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dmg certificate SHA-1 does not match provenance authorization");
  });

  it("creates and verifies exact checksums for every required release evidence asset", async () => {
    const source = await fixture();
    const create = spawnSync(process.execPath, [checksumCreator, source.directory], { cwd: repositoryRoot, encoding: "utf8" });
    expect(create.status, create.stderr).toBe(0);
    const checksumText = await readFile(path.join(source.directory, "SHA256SUMS.txt"), "utf8");
    for (const name of Object.values(source.names)) expect(checksumText).toContain(`  ${name}\n`);
    const validate = spawnSync(process.execPath, [checksumValidator, source.directory], { cwd: repositoryRoot, encoding: "utf8" });
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("6 exact release assets");
    await writeFile(path.join(source.directory, source.names.sbom), "tampered");
    const tampered = spawnSync(process.execPath, [checksumValidator, source.directory], { cwd: repositoryRoot, encoding: "utf8" });
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain("SBOM.cdx.json SHA-256 mismatch");
  });
});
