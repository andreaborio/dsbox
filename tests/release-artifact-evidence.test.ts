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
    schemaVersion: 1,
    subject: { name: "Hebrus Studio", packageName: "hebrus-studio", version: "0.4.0", platform: "macOS", architecture: "arm64" },
    source: { repository: "andreaborio/hebrus-studio", commit: sourceCommit, tag: "v0.4.0", treeState: "clean" },
    build: { provider: "github-actions", workflow: "release-macos", event: "push", refType: "tag", runId: "123", runAttempt: "1", runnerOs: "macOS", runnerArch: "X64", githubActions: true }
  }, null, 2)}\n`;
  await writeFile(provenancePath, provenanceText);
  const report = {
    schemaVersion: 1,
    result: "pass",
    startedAt: "2026-07-21T00:00:00.000Z",
    completedAt: "2026-07-21T00:01:00.000Z",
    product: { name: "Hebrus Studio", version: "0.4.0", bundleIdentifier: contract.bundleIdentifier, architecture: "arm64" },
    source: { commit: sourceCommit, tag: "v0.4.0", provenanceSha256: sha256(provenanceText) },
    artifacts: {
      dmg: { fileName: names.dmg, sha256: sha256(values.dmg) },
      sbom: { fileName: names.sbom, sha256: sha256(values.sbom) },
      log: { fileName: names.log, sha256: sha256(values.log) },
      packagedAppPath: "Hebrus Studio.app"
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

  it("creates and verifies exact checksums for every required release evidence asset", async () => {
    const source = await fixture();
    const create = spawnSync(process.execPath, [checksumCreator, source.directory], { cwd: repositoryRoot, encoding: "utf8" });
    expect(create.status, create.stderr).toBe(0);
    const checksumText = await readFile(path.join(source.directory, "SHA256SUMS.txt"), "utf8");
    for (const name of Object.values(source.names)) expect(checksumText).toContain(`  ${name}\n`);
    const validate = spawnSync(process.execPath, [checksumValidator, source.directory], { cwd: repositoryRoot, encoding: "utf8" });
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("5 exact release assets");
    await writeFile(path.join(source.directory, source.names.sbom), "tampered");
    const tampered = spawnSync(process.execPath, [checksumValidator, source.directory], { cwd: repositoryRoot, encoding: "utf8" });
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain("SBOM.cdx.json SHA-256 mismatch");
  });
});
