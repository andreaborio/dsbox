import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const checker = path.join(repositoryRoot, "scripts", "check-public-release-readiness.mjs");
const manifestPath = path.join(repositoryRoot, "scripts", "public-release-readiness.json");
const requiredGateIds = [
  "naming-legal-approval",
  "private-vulnerability-reporting",
  "private-conduct-intake",
  "developer-id-signing",
  "notarization-stapling",
  "hosted-ci-exact-commit",
  "engine-model-backed-exact-commit"
];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("public-release readiness interlock", () => {
  it("keeps every external launch gate explicitly false and pending", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      productName: "Hebrus Studio",
      candidateVersion: "0.4.0",
      publicRelease: { state: "blocked" }
    });
    expect(manifest.gates.map((gate: { id: string }) => gate.id)).toEqual(requiredGateIds);
    for (const gate of manifest.gates) {
      expect(gate).toMatchObject({ ready: false, status: "pending", evidence: null });
      expect(gate.requirement).toEqual(expect.any(String));
      expect(gate.remediation).toEqual(expect.any(String));
    }
  });

  it("passes in status mode and reports every pending gate deterministically", () => {
    const result = spawnSync(process.execPath, [checker, "--status"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("BLOCKED (0/7 ready)");
    expect(result.stdout).toContain("Status mode reports pending gates without authorizing a public release.");
    const positions = requiredGateIds.map((id) => result.stdout.indexOf(`PENDING ${id}:`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("fails closed in strict mode with one precise line per pending gate", () => {
    const result = spawnSync(process.execPath, [checker, "--strict"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PUBLIC RELEASE BLOCKED: 7 required gate(s) are pending");
    expect(result.stderr).toContain("Strict mode refused to build or publish the public release.");
    for (const id of requiredGateIds) expect(result.stderr).toContain(`- ${id}:`);
  });

  it("rejects contradictory readiness fields as invalid input", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-readiness-test-"));
    temporaryDirectories.push(directory);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.gates[0].ready = true;
    const invalidPath = path.join(directory, "invalid.json");
    await writeFile(invalidPath, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [checker, "--status", "--manifest", invalidPath], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("naming-legal-approval must use ready=true/status=ready or ready=false/status=pending");
    expect(result.stderr).toContain("naming-legal-approval.evidence must be an object when the gate is ready");
  });

  it("runs strict mode before build and publish while normal CI uses status only", async () => {
    const [releaseWorkflow, ciWorkflow, packageJsonText] = await Promise.all([
      readFile(path.join(repositoryRoot, ".github", "workflows", "release-macos.yml"), "utf8"),
      readFile(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
      readFile(path.join(repositoryRoot, "package.json"), "utf8")
    ]);
    const packageJson = JSON.parse(packageJsonText);
    expect(packageJson.scripts["release:readiness"]).toContain("--status");
    expect(packageJson.scripts["release:readiness:strict"]).toContain("--strict");
    const strict = releaseWorkflow.indexOf("npm run release:readiness:strict");
    const build = releaseWorkflow.indexOf("npm run dist:mac");
    const publish = releaseWorkflow.indexOf("gh release create");
    expect(strict).toBeGreaterThan(0);
    expect(strict).toBeLessThan(build);
    expect(build).toBeLessThan(publish);
    expect(ciWorkflow).toContain("npm run release:readiness");
    expect(ciWorkflow).not.toContain("release:readiness:strict");
  });

  it("does not advertise a stale public release while readiness is blocked", async () => {
    const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
    expect(readme).toContain("Hebrus Studio 0.4.0 release candidate");
    expect(readme).toContain("docs/PACKAGING-macOS.md");
    expect(readme).toContain("docs/INSTALL-macOS.md");
    expect(readme).not.toContain("releases/latest");
    expect(readme).not.toContain("Latest release");
    expect(readme).not.toContain("Download for Apple Silicon");
    expect(readme).toContain("final launch commit will restore the");
  });
});
