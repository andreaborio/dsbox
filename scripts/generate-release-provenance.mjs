#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readJson, sha256Buffer, writeJsonAtomic } from "./release-artifact-utils.mjs";

const defaultRepository = path.resolve(import.meta.dirname, "..");

function usage() {
  return "Usage: node scripts/generate-release-provenance.mjs --output <path> [--repository <path>]";
}

function parseArgs(argv) {
  const options = { repository: defaultRepository, output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.output = argv[++index] || "";
    else if (argument === "--repository") options.repository = path.resolve(argv[++index] || "");
    else if (["--help", "-h"].includes(argument)) {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.output) throw new Error(usage());
  options.output = path.resolve(options.repository, options.output);
  return options;
}

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function requireEnvironment(name, predicate = (value) => Boolean(value)) {
  const value = process.env[name] ?? "";
  if (!predicate(value)) throw new Error(`Release provenance requires a valid ${name}`);
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const readinessPath = path.join(options.repository, "scripts", "public-release-readiness.json");
  const [packageJson, readinessBytes] = await Promise.all([
    readJson(path.join(options.repository, "package.json")),
    readFile(readinessPath)
  ]);
  const readiness = JSON.parse(readinessBytes.toString("utf8"));
  const expectedTag = `v${packageJson.version}`;
  const head = git(options.repository, ["rev-parse", "HEAD"]);
  const status = git(options.repository, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new Error(`Release provenance requires a clean source tree:\n${status}`);

  const githubActions = requireEnvironment("GITHUB_ACTIONS", (value) => value === "true");
  const eventName = requireEnvironment("GITHUB_EVENT_NAME", (value) => value === "push");
  const refType = requireEnvironment("GITHUB_REF_TYPE", (value) => value === "tag");
  const refName = requireEnvironment("GITHUB_REF_NAME", (value) => value === expectedTag);
  const githubSha = requireEnvironment("GITHUB_SHA", (value) => /^[a-f0-9]{40}$/i.test(value));
  const repository = requireEnvironment("GITHUB_REPOSITORY", (value) => /^[^/]+\/[^/]+$/.test(value));
  const runId = requireEnvironment("GITHUB_RUN_ID", (value) => /^\d+$/.test(value));
  const runAttempt = requireEnvironment("GITHUB_RUN_ATTEMPT", (value) => /^\d+$/.test(value));
  const runnerOs = requireEnvironment("RUNNER_OS");
  const runnerArch = requireEnvironment("RUNNER_ARCH");
  const signingCommonName = requireEnvironment("HEBRUS_SIGNING_CERTIFICATE_COMMON_NAME", (value) => value.startsWith("Developer ID Application:"));
  const signingSha1 = requireEnvironment("HEBRUS_SIGNING_CERTIFICATE_SHA1", (value) => /^[a-f0-9]{40}$/i.test(value));
  const signingTeamId = requireEnvironment("HEBRUS_SIGNING_TEAM_ID", (value) => /^[A-Z0-9]{10}$/.test(value));
  if (githubSha !== head) throw new Error(`GITHUB_SHA ${githubSha} does not equal clean-tree HEAD ${head}`);

  if (readiness.publicRelease?.state !== "ready") throw new Error("Release provenance requires publicRelease.state=ready");
  const gates = new Map((readiness.gates ?? []).map((gate) => [gate.id, gate]));
  const signingEvidence = gates.get("developer-id-signing")?.evidence;
  const notarizationEvidence = gates.get("notarization-stapling")?.evidence;
  if (
    gates.get("developer-id-signing")?.ready !== true
    || signingEvidence?.certificateCommonName !== signingCommonName
    || signingEvidence?.certificateSha1?.toLowerCase() !== signingSha1.toLowerCase()
    || signingEvidence?.teamIdentifier !== signingTeamId
  ) {
    throw new Error("Protected signing identity does not match ready Developer ID evidence");
  }
  if (
    gates.get("notarization-stapling")?.ready !== true
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(notarizationEvidence?.submissionId ?? "")
  ) {
    throw new Error("Ready notarization qualification evidence is missing a valid submission id");
  }

  let taggedCommit = "";
  try {
    taggedCommit = git(options.repository, ["rev-parse", `refs/tags/${expectedTag}^{commit}`]);
  } catch {
    throw new Error(`Required release tag ${expectedTag} does not exist in the checkout`);
  }
  if (taggedCommit !== head) throw new Error(`Release tag ${expectedTag} points to ${taggedCommit}, not HEAD ${head}`);

  const provenance = {
    schemaVersion: 2,
    subject: {
      name: "Hebrus Studio",
      packageName: packageJson.name,
      version: packageJson.version,
      platform: "macOS",
      architecture: "arm64"
    },
    source: {
      repository,
      commit: head,
      tag: refName,
      treeState: "clean"
    },
    build: {
      provider: "github-actions",
      workflow: "release-macos",
      event: eventName,
      refType,
      runId,
      runAttempt,
      runnerOs,
      runnerArch,
      githubActions: githubActions === "true"
    },
    authorization: {
      readinessManifestSha256: sha256Buffer(readinessBytes),
      signing: {
        certificateCommonName: signingCommonName,
        certificateSha1: signingSha1.toLowerCase(),
        teamIdentifier: signingTeamId
      },
      notarizationQualificationSubmissionId: notarizationEvidence.submissionId
    }
  };
  await writeJsonAtomic(options.output, provenance);
  console.log(`Generated release provenance for ${head} at ${options.output}`);
}

main().catch((error) => {
  console.error(`Could not generate release provenance: ${error.message}`);
  process.exitCode = 1;
});
