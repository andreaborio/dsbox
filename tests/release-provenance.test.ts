import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const generator = path.join(repositoryRoot, "scripts", "generate-release-provenance.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "hebrus-provenance-test-"));
  temporaryDirectories.push(directory);
  const repository = path.join(directory, "repository");
  await mkdir(repository);
  await mkdir(path.join(repository, "scripts"));
  await writeFile(path.join(repository, "package.json"), JSON.stringify({ name: "hebrus-studio", version: "0.4.0" }));
  await writeFile(path.join(repository, "scripts", "public-release-readiness.json"), JSON.stringify({
    publicRelease: { state: "ready" },
    gates: [
      {
        id: "developer-id-signing",
        ready: true,
        evidence: {
          certificateCommonName: "Developer ID Application: Hebrus Test (ABCDE12345)",
          certificateSha1: "b".repeat(40),
          teamIdentifier: "ABCDE12345"
        }
      },
      {
        id: "notarization-stapling",
        ready: true,
        evidence: { submissionId: "12345678-1234-4234-8234-123456789abc" }
      }
    ]
  }));
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "release-test@example.invalid"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Release Test"]);
  execFileSync("git", ["-C", repository, "add", "package.json", "scripts/public-release-readiness.json"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  execFileSync("git", ["-C", repository, "tag", "v0.4.0"]);
  const commit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { directory, repository, commit, output: path.join(directory, "release-provenance.json") };
}

function environment(commit: string) {
  return {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v0.4.0",
    GITHUB_SHA: commit,
    GITHUB_REPOSITORY: "andreaborio/hebrus-studio",
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_OS: "macOS",
    RUNNER_ARCH: "ARM64",
    HEBRUS_SIGNING_CERTIFICATE_COMMON_NAME: "Developer ID Application: Hebrus Test (ABCDE12345)",
    HEBRUS_SIGNING_CERTIFICATE_SHA1: "b".repeat(40),
    HEBRUS_SIGNING_TEAM_ID: "ABCDE12345"
  };
}

describe("exact-commit release provenance", () => {
  it("records a clean, exact tagged GitHub Actions commit", async () => {
    const source = await fixture();
    const result = spawnSync(process.execPath, [generator, "--repository", source.repository, "--output", source.output], {
      encoding: "utf8",
      env: environment(source.commit)
    });
    expect(result.status, result.stderr).toBe(0);
    const provenance = JSON.parse(await readFile(source.output, "utf8"));
    expect(provenance).toMatchObject({
      schemaVersion: 2,
      subject: { name: "Hebrus Studio", packageName: "hebrus-studio", version: "0.4.0" },
      source: { commit: source.commit, tag: "v0.4.0", treeState: "clean" },
      build: { provider: "github-actions", workflow: "release-macos", event: "push", refType: "tag", githubActions: true },
      authorization: {
        signing: {
          certificateCommonName: "Developer ID Application: Hebrus Test (ABCDE12345)",
          certificateSha1: "b".repeat(40),
          teamIdentifier: "ABCDE12345"
        },
        notarizationQualificationSubmissionId: "12345678-1234-4234-8234-123456789abc"
      }
    });
  });

  it("fails closed for a dirty source tree", async () => {
    const source = await fixture();
    await writeFile(path.join(source.repository, "untracked.txt"), "dirty");
    const result = spawnSync(process.execPath, [generator, "--repository", source.repository, "--output", source.output], {
      encoding: "utf8",
      env: environment(source.commit)
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a clean source tree");
    await expect(readFile(source.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the workflow SHA does not equal the tagged HEAD", async () => {
    const source = await fixture();
    const result = spawnSync(process.execPath, [generator, "--repository", source.repository, "--output", source.output], {
      encoding: "utf8",
      env: environment("f".repeat(40))
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not equal clean-tree HEAD");
  });
});
