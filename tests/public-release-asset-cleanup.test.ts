import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const cleaner = path.join(repositoryRoot, "scripts", "clean-public-release-assets.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("development packaging public-asset cleanup", () => {
  it("removes only the exact current public release set and preserves development or unrelated files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-public-cleanup-test-"));
    temporaryDirectories.push(directory);
    const releaseDirectory = path.join(directory, "release");
    const developmentDirectory = path.join(releaseDirectory, "development-evidence");
    await mkdir(developmentDirectory, { recursive: true });
    const contract = JSON.parse(await readFile(path.join(repositoryRoot, "scripts", "macos-package-contract.json"), "utf8"));
    const publicNames = [
      ...contract.checksums.requiredFileNameTemplates.map((template: string) => template.replaceAll("{version}", "0.4.0")),
      contract.checksums.fileName
    ];
    await Promise.all([
      ...publicNames.map((fileName: string) => writeFile(path.join(releaseDirectory, fileName), `stale ${fileName}\n`)),
      writeFile(path.join(developmentDirectory, "development-report.json"), "development evidence\n"),
      writeFile(path.join(releaseDirectory, "unrelated-notes.txt"), "keep me\n"),
      writeFile(path.join(releaseDirectory, "Hebrus-Studio-0.3.2-SBOM.cdx.json"), "older release\n")
    ]);

    const result = spawnSync(process.execPath, [cleaner, releaseDirectory], { cwd: repositoryRoot, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const fileName of publicNames) {
      await expect(stat(path.join(releaseDirectory, fileName))).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.stdout).toContain(fileName);
    }
    await expect(readFile(path.join(developmentDirectory, "development-report.json"), "utf8")).resolves.toBe("development evidence\n");
    await expect(readFile(path.join(releaseDirectory, "unrelated-notes.txt"), "utf8")).resolves.toBe("keep me\n");
    await expect(readFile(path.join(releaseDirectory, "Hebrus-Studio-0.3.2-SBOM.cdx.json"), "utf8")).resolves.toBe("older release\n");
  });

  it("refuses a directory at an exact public asset path instead of deleting recursively", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hebrus-public-cleanup-safety-test-"));
    temporaryDirectories.push(directory);
    const releaseDirectory = path.join(directory, "release");
    await mkdir(path.join(releaseDirectory, "SHA256SUMS.txt"), { recursive: true });
    const result = spawnSync(process.execPath, [cleaner, releaseDirectory], { cwd: repositoryRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to remove non-file public release asset");
    await expect(stat(path.join(releaseDirectory, "SHA256SUMS.txt"))).resolves.toBeDefined();
  });
});
