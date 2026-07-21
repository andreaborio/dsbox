import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const normalizer = path.join(repositoryRoot, "scripts", "normalize-release-sbom.mjs");
const validator = path.join(repositoryRoot, "scripts", "validate-release-sbom.mjs");
const temporaryDirectories: string[] = [];

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

function normalize(raw: string) {
  const result = spawnSync(process.execPath, [normalizer], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: raw,
    maxBuffer: 32 * 1024 * 1024
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("CycloneDX release SBOM", () => {
  it("normalizes and validates the complete lockfile-derived npm SBOM", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-sbom-test-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "Hebrus-Studio-0.4.0-SBOM.cdx.json");
    const normalized = normalize(npmCycloneDx());
    await writeFile(outputPath, normalized);
    const result = spawnSync(process.execPath, [validator, outputPath], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("CycloneDX 1.5");
    const sbom = JSON.parse(normalized);
    expect(sbom.metadata.component).toMatchObject({
      type: "application",
      name: "hebrus-studio",
      version: "0.4.0",
      purl: "pkg:npm/hebrus-studio@0.4.0"
    });
    expect(sbom.components.some((component: { name?: string }) => component.name === "electron")).toBe(true);
    const lockfile = await readFile(path.join(repositoryRoot, "package-lock.json"));
    expect(sbom.metadata.properties).toContainEqual({
      name: "hebrus:package-lock:sha256",
      value: createHash("sha256").update(lockfile).digest("hex")
    });
  }, 20_000);

  it("rejects the right filename carrying the wrong SBOM format", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-sbom-negative-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "Hebrus-Studio-0.4.0-SBOM.cdx.json");
    const sbom = JSON.parse(normalize(npmCycloneDx()));
    sbom.bomFormat = "SPDX";
    await writeFile(outputPath, JSON.stringify(sbom));
    const result = spawnSync(process.execPath, [validator, outputPath], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bomFormat must be CycloneDX");
  }, 20_000);

  it("pins generation, validation, naming, and publication in the release workflow", async () => {
    const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "release-macos.yml"), "utf8");
    expect(workflow).toContain("npm sbom --sbom-format cyclonedx --sbom-type application --package-lock-only");
    expect(workflow).toContain("node scripts/normalize-release-sbom.mjs");
    expect(workflow).toContain("node scripts/validate-release-sbom.mjs");
    expect(workflow).toContain("Hebrus-Studio-${{ steps.version.outputs.version }}-SBOM.cdx.json#CycloneDX SBOM");
    expect(workflow.indexOf("npm run release:readiness:strict")).toBeLessThan(workflow.indexOf("npm sbom"));
  });
});
