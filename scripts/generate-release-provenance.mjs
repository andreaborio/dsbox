#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./release-artifact-utils.mjs";

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
  const packageJson = await readJson(path.join(options.repository, "package.json"));
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
  if (githubSha !== head) throw new Error(`GITHUB_SHA ${githubSha} does not equal clean-tree HEAD ${head}`);

  let taggedCommit = "";
  try {
    taggedCommit = git(options.repository, ["rev-parse", `refs/tags/${expectedTag}^{commit}`]);
  } catch {
    throw new Error(`Required release tag ${expectedTag} does not exist in the checkout`);
  }
  if (taggedCommit !== head) throw new Error(`Release tag ${expectedTag} points to ${taggedCommit}, not HEAD ${head}`);

  const provenance = {
    schemaVersion: 1,
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
    }
  };
  await writeJsonAtomic(options.output, provenance);
  console.log(`Generated release provenance for ${head} at ${options.output}`);
}

main().catch((error) => {
  console.error(`Could not generate release provenance: ${error.message}`);
  process.exitCode = 1;
});
