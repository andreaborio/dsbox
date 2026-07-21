import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const normalizer = path.join(repositoryRoot, "scripts", "normalize-release-sbom.mjs");
const validator = path.join(repositoryRoot, "scripts", "validate-release-sbom.mjs");
const inventoryCreator = path.join(repositoryRoot, "scripts", "create-release-license-inventory.mjs");
const temporaryDirectories: string[] = [];
const sourceCommit = "a".repeat(40);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function npmCycloneDx() {
  const result = spawnSync("npm", [
    "sbom",
    "--sbom-format", "cyclonedx",
    "--sbom-type", "application",
    "--package-lock-only"
  ], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

async function provenance(directory: string) {
  const output = path.join(directory, "release-provenance.json");
  await writeFile(path.join(directory, "release-attestation.json"), "release attestation evidence\n");
  await writeFile(output, `${JSON.stringify({
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
  }, null, 2)}\n`);
  return output;
}

function normalize(raw: string, provenancePath: string) {
  const result = spawnSync(process.execPath, [
    normalizer,
    "--provenance", provenancePath,
    "--attestation", path.join(path.dirname(provenancePath), "release-attestation.json")
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: raw,
    maxBuffer: 32 * 1024 * 1024
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("CycloneDX release SBOM", () => {
  it("enriches, normalizes, and validates every lockfile-derived component license", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-sbom-test-"));
    temporaryDirectories.push(directory);
    const provenancePath = await provenance(directory);
    const outputPath = path.join(directory, "Hebrus-Studio-0.4.0-SBOM.cdx.json");
    const normalized = normalize(npmCycloneDx(), provenancePath);
    await writeFile(outputPath, normalized);
    const result = spawnSync(process.execPath, [validator, outputPath, "--provenance", provenancePath, "--attestation", path.join(directory, "release-attestation.json")], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("identifiable licenses");
    const sbom = JSON.parse(normalized);
    expect(sbom.metadata.component).toMatchObject({
      type: "application",
      name: "hebrus-studio",
      version: "0.4.0",
      purl: "pkg:npm/hebrus-studio@0.4.0"
    });
    expect(sbom.components.some((component: { name?: string }) => component.name === "electron")).toBe(true);
    expect(sbom.components.every((component: { licenses?: unknown[] }) => (component.licenses?.length ?? 0) > 0)).toBe(true);
    const lock = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
    expect(sbom.components).toHaveLength(Object.keys(lock.packages).length - 1);
    const lockPaths = sbom.components.map((component: { properties?: Array<{ name: string; value: string }> }) => (
      component.properties?.find((property) => property.name === "hebrus:package-lock:path")?.value
    ));
    expect(new Set(lockPaths).size).toBe(lockPaths.length);
    expect(sbom.components.some((component: { properties?: Array<{ name: string }> }) => (
      component.properties?.some((property) => property.name === "hebrus:license-metadata-source")
    ))).toBe(true);
    const lockfile = await readFile(path.join(repositoryRoot, "package-lock.json"));
    expect(sbom.metadata.properties).toContainEqual({
      name: "hebrus:package-lock:sha256",
      value: createHash("sha256").update(lockfile).digest("hex")
    });
    expect(sbom.metadata.properties).toContainEqual({ name: "hebrus:source-commit", value: sourceCommit });

    const inventoryPath = path.join(directory, "Hebrus-Studio-0.4.0-THIRD-PARTY-LICENSES.md");
    const inventory = spawnSync(process.execPath, [inventoryCreator, outputPath, inventoryPath], { cwd: repositoryRoot, encoding: "utf8" });
    expect(inventory.status, inventory.stderr).toBe(0);
    const inventoryText = await readFile(inventoryPath, "utf8");
    expect(inventoryText).toContain("third-party license inventory");
    expect(inventoryText).toContain("| electron | 43.1.0 | node_modules/electron | development | MIT |");
    expect(inventoryText.split("\n").filter((line) => line.startsWith("| ")).length).toBe(sbom.components.length + 2);
  }, 20_000);

  it("rejects the right filename carrying the wrong SBOM format", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-sbom-negative-"));
    temporaryDirectories.push(directory);
    const provenancePath = await provenance(directory);
    const outputPath = path.join(directory, "Hebrus-Studio-0.4.0-SBOM.cdx.json");
    const sbom = JSON.parse(normalize(npmCycloneDx(), provenancePath));
    sbom.bomFormat = "SPDX";
    await writeFile(outputPath, JSON.stringify(sbom));
    const result = spawnSync(process.execPath, [validator, outputPath, "--provenance", provenancePath, "--attestation", path.join(directory, "release-attestation.json")], { cwd: repositoryRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bomFormat must be CycloneDX");
  }, 20_000);

  it("fails closed for missing or non-identifiable component licenses", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-sbom-license-negative-"));
    temporaryDirectories.push(directory);
    const provenancePath = await provenance(directory);
    const outputPath = path.join(directory, "Hebrus-Studio-0.4.0-SBOM.cdx.json");
    const sbom = JSON.parse(normalize(npmCycloneDx(), provenancePath));
    delete sbom.components[0].licenses;
    sbom.components[1].licenses = [{ license: { name: "see bundled file" } }];
    await writeFile(outputPath, JSON.stringify(sbom));
    const result = spawnSync(process.execPath, [validator, outputPath, "--provenance", provenancePath, "--attestation", path.join(directory, "release-attestation.json")], { cwd: repositoryRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no license metadata");
    expect(result.stderr).toContain("must use a recognized SPDX id or expression");
  }, 20_000);

  it("fails closed when a transitive lockfile occurrence or dependency edge is omitted", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-sbom-completeness-negative-"));
    temporaryDirectories.push(directory);
    const provenancePath = await provenance(directory);
    const outputPath = path.join(directory, "Hebrus-Studio-0.4.0-SBOM.cdx.json");
    const sbom = JSON.parse(normalize(npmCycloneDx(), provenancePath));
    const removed = sbom.components.find((component: { name?: string }) => component.name === "@electron-internal/extract-zip");
    sbom.components = sbom.components.filter((component: { "bom-ref": string }) => component["bom-ref"] !== removed["bom-ref"]);
    await writeFile(outputPath, JSON.stringify(sbom));
    const omittedComponent = spawnSync(process.execPath, [validator, outputPath, "--provenance", provenancePath, "--attestation", path.join(directory, "release-attestation.json")], { cwd: repositoryRoot, encoding: "utf8" });
    expect(omittedComponent.status).toBe(1);
    expect(omittedComponent.stderr).toContain("component package-lock paths do not exactly match package-lock.json");

    const complete = JSON.parse(normalize(npmCycloneDx(), provenancePath));
    const node = complete.dependencies.find((dependency: { dependsOn?: string[] }) => (dependency.dependsOn?.length ?? 0) > 0);
    node.dependsOn.pop();
    await writeFile(outputPath, JSON.stringify(complete));
    const omittedEdge = spawnSync(process.execPath, [validator, outputPath, "--provenance", provenancePath, "--attestation", path.join(directory, "release-attestation.json")], { cwd: repositoryRoot, encoding: "utf8" });
    expect(omittedEdge.status).toBe(1);
    expect(omittedEdge.stderr).toContain("dependency edges do not match package-lock.json");
  }, 20_000);

  it("pins provenance, license inventory, validation, naming, and workflow order", async () => {
    const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "release-macos.yml"), "utf8");
    expect(workflow).toContain("npm sbom --sbom-format cyclonedx --sbom-type application --package-lock-only");
    expect(workflow).toContain("normalize-release-sbom.mjs --provenance build/release-provenance.json --attestation \"$ATTESTATION_PATH\"");
    expect(workflow).toContain("validate-release-sbom.mjs \"$SBOM_PATH\" --provenance build/release-provenance.json --attestation \"$ATTESTATION_PATH\"");
    expect(workflow).toContain("create-release-license-inventory.mjs");
    expect(workflow).toContain("Hebrus-Studio-${{ steps.version.outputs.version }}-SBOM.cdx.json#CycloneDX SBOM");
    expect(workflow).toContain("Hebrus-Studio-${{ steps.version.outputs.version }}-THIRD-PARTY-LICENSES.md#Third-party license inventory");
    const strict = workflow.indexOf("npm run release:readiness:strict");
    const provenance = workflow.indexOf("npm run release:provenance");
    const build = workflow.indexOf("npm run dist:mac");
    const sbom = workflow.indexOf("npm sbom");
    const e2e = workflow.indexOf("verify:upgrade-rollback:e2e -- --release");
    const checksums = workflow.indexOf("npm run release:checksums");
    const publish = workflow.indexOf("gh release create");
    expect(strict).toBeLessThan(provenance);
    expect(provenance).toBeLessThan(build);
    expect(build).toBeLessThan(sbom);
    expect(sbom).toBeLessThan(e2e);
    expect(e2e).toBeLessThan(checksums);
    expect(checksums).toBeLessThan(publish);
  });
});
