#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const defaultManifestPath = path.join(repositoryRoot, "scripts", "public-release-readiness.json");
const packagePath = path.join(repositoryRoot, "package.json");
const requiredGateIds = [
  "naming-legal-approval",
  "private-vulnerability-reporting",
  "private-conduct-intake",
  "developer-id-signing",
  "notarization-stapling",
  "hosted-ci-exact-commit",
  "engine-model-backed-exact-commit"
];

function usage() {
  return "Usage: node scripts/check-public-release-readiness.mjs (--status | --strict) [--manifest <path>]";
}

function parseArguments(argv) {
  let mode = null;
  let manifestPath = defaultManifestPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--status" || argument === "--strict") {
      if (mode) throw new Error("Choose exactly one readiness mode.");
      mode = argument.slice(2);
    } else if (argument === "--manifest") {
      const value = argv[++index];
      if (!value) throw new Error("--manifest requires a path.");
      manifestPath = path.resolve(value);
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!mode) throw new Error("A readiness mode is required.");
  return { mode, manifestPath };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, field, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${field} must be a non-empty string`);
}

function requireEvidenceFields(gate, fields, errors) {
  if (!isRecord(gate.evidence)) {
    errors.push(`${gate.id}.evidence must be an object when the gate is ready`);
    return;
  }
  for (const field of ["verifiedBy", "verifiedAt", ...fields]) {
    requireString(gate.evidence[field], `${gate.id}.evidence.${field}`, errors);
  }
  if (
    typeof gate.evidence.verifiedAt === "string"
    && Number.isNaN(Date.parse(gate.evidence.verifiedAt))
  ) {
    errors.push(`${gate.id}.evidence.verifiedAt must be an ISO-8601 timestamp`);
  }
}

function validateReadyEvidence(gate, errors) {
  const fieldsByGate = {
    "naming-legal-approval": ["approvalReference"],
    "private-vulnerability-reporting": ["intakeReference", "testReference"],
    "private-conduct-intake": ["intakeReference", "testReference"],
    "developer-id-signing": ["certificateCommonName", "certificateSha1", "verificationReference"],
    "notarization-stapling": ["submissionId", "stapleVerification", "gatekeeperVerification"],
    "hosted-ci-exact-commit": ["workflowReference"],
    "engine-model-backed-exact-commit": ["engineCommit", "modelArtifactSha256", "reportReference"]
  };
  requireEvidenceFields(gate, fieldsByGate[gate.id] ?? [], errors);
  if (!isRecord(gate.evidence)) return;
  if (
    gate.id === "developer-id-signing"
    && typeof gate.evidence.certificateCommonName === "string"
    && !gate.evidence.certificateCommonName.startsWith("Developer ID Application:")
  ) {
    errors.push(`${gate.id}.evidence.certificateCommonName must name a Developer ID Application certificate`);
  }
  if (
    gate.id === "developer-id-signing"
    && typeof gate.evidence.certificateSha1 === "string"
    && !/^[a-f0-9]{40}$/i.test(gate.evidence.certificateSha1)
  ) {
    errors.push(`${gate.id}.evidence.certificateSha1 must be a full 40-character SHA-1 fingerprint`);
  }
  if (
    gate.id === "engine-model-backed-exact-commit"
    && typeof gate.evidence.engineCommit === "string"
    && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(gate.evidence.engineCommit)
  ) {
    errors.push(`${gate.id}.evidence.engineCommit must be a full 40- or 64-character commit id`);
  }
  if (
    gate.id === "engine-model-backed-exact-commit"
    && typeof gate.evidence.modelArtifactSha256 === "string"
    && !/^[a-f0-9]{64}$/i.test(gate.evidence.modelArtifactSha256)
  ) {
    errors.push(`${gate.id}.evidence.modelArtifactSha256 must be a full SHA-256 digest`);
  }
}

function validateManifest(manifest, packageJson) {
  const errors = [];
  if (!isRecord(manifest)) return ["manifest root must be an object"];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (manifest.productName !== "Hebrus Studio") errors.push("productName must be Hebrus Studio");
  if (manifest.candidateVersion !== packageJson.version) {
    errors.push(`candidateVersion ${JSON.stringify(manifest.candidateVersion)} must match package version ${packageJson.version}`);
  }
  if (!isRecord(manifest.publicRelease)) errors.push("publicRelease must be an object");
  else {
    if (!["blocked", "ready"].includes(manifest.publicRelease.state)) {
      errors.push("publicRelease.state must be blocked or ready");
    }
    requireString(manifest.publicRelease.policy, "publicRelease.policy", errors);
  }
  if (!Array.isArray(manifest.gates)) {
    errors.push("gates must be an array");
    return errors;
  }
  const observedIds = manifest.gates.map((gate) => gate?.id);
  if (new Set(observedIds).size !== observedIds.length) errors.push("gate ids must be unique");
  if (JSON.stringify(observedIds) !== JSON.stringify(requiredGateIds)) {
    errors.push(`gates must appear exactly in this order: ${requiredGateIds.join(", ")}`);
  }
  for (const gate of manifest.gates) {
    if (!isRecord(gate)) {
      errors.push("every gate must be an object");
      continue;
    }
    requireString(gate.id, "gate.id", errors);
    requireString(gate.title, `${gate.id}.title`, errors);
    requireString(gate.requirement, `${gate.id}.requirement`, errors);
    requireString(gate.remediation, `${gate.id}.remediation`, errors);
    if (typeof gate.ready !== "boolean") errors.push(`${gate.id}.ready must be boolean`);
    if (!["pending", "ready"].includes(gate.status)) errors.push(`${gate.id}.status must be pending or ready`);
    if (gate.ready !== (gate.status === "ready")) {
      errors.push(`${gate.id} must use ready=true/status=ready or ready=false/status=pending`);
    }
    if (gate.ready) validateReadyEvidence(gate, errors);
    else if (gate.evidence !== null) errors.push(`${gate.id}.evidence must be null while pending`);
  }
  const pendingCount = manifest.gates.filter((gate) => gate?.ready !== true).length;
  const expectedState = pendingCount === 0 ? "ready" : "blocked";
  if (manifest.publicRelease?.state !== expectedState) {
    errors.push(`publicRelease.state must be ${expectedState} for ${pendingCount} pending gate(s)`);
  }
  return errors;
}

async function implementationBlockers(manifest, packageJson, environment) {
  const blockers = [];
  const gates = new Map(manifest.gates.map((gate) => [gate.id, gate]));
  if (gates.get("developer-id-signing")?.ready) {
    const builder = await readFile(path.join(repositoryRoot, "electron-builder.yml"), "utf8");
    const verifier = await readFile(path.join(repositoryRoot, "scripts", "verify-macos-release.sh"), "utf8");
    if (/^\s*identity:\s*["']?-["']?\s*$/m.test(builder)) {
      blockers.push("developer-id-signing: electron-builder.yml still selects the ad-hoc identity '-'");
    }
    if (/Expected an ad-hoc signature/.test(verifier)) {
      blockers.push("developer-id-signing: the package verifier still requires an ad-hoc signature");
    }
  }
  if (gates.get("notarization-stapling")?.ready) {
    const builder = await readFile(path.join(repositoryRoot, "electron-builder.yml"), "utf8");
    const verifier = await readFile(path.join(repositoryRoot, "scripts", "verify-macos-release.sh"), "utf8");
    if (/^\s*hardenedRuntime:\s*false\s*$/m.test(builder)) {
      blockers.push("notarization-stapling: hardenedRuntime is still disabled");
    }
    if (!/stapler\s+validate/.test(verifier) || !/spctl\s+--assess/.test(verifier)) {
      blockers.push("notarization-stapling: the package verifier does not yet enforce stapling and Gatekeeper assessment");
    }
  }
  if (gates.get("hosted-ci-exact-commit")?.ready) {
    if (environment.GITHUB_ACTIONS !== "true") blockers.push("hosted-ci-exact-commit: strict mode must run inside GitHub Actions");
    if (environment.GITHUB_REF_TYPE !== "tag" || environment.GITHUB_REF_NAME !== `v${packageJson.version}`) {
      blockers.push(`hosted-ci-exact-commit: expected tag v${packageJson.version}, got ${environment.GITHUB_REF_NAME || "<unset>"}`);
    }
    if (!/^[a-f0-9]{40}$/i.test(environment.GITHUB_SHA ?? "")) {
      blockers.push("hosted-ci-exact-commit: GITHUB_SHA is not a full commit id");
    }
    if (environment.HEBRUS_HOSTED_CI_COMMIT !== environment.GITHUB_SHA) {
      blockers.push("hosted-ci-exact-commit: HEBRUS_HOSTED_CI_COMMIT does not equal the tagged GITHUB_SHA");
    }
  }
  const engineGate = gates.get("engine-model-backed-exact-commit");
  if (engineGate?.ready) {
    if (environment.HEBRUS_MODEL_BACKED_STUDIO_COMMIT !== environment.GITHUB_SHA) {
      blockers.push("engine-model-backed-exact-commit: HEBRUS_MODEL_BACKED_STUDIO_COMMIT does not equal the tagged GITHUB_SHA");
    }
    if (environment.HEBRUS_MODEL_BACKED_ENGINE_COMMIT !== engineGate.evidence.engineCommit) {
      blockers.push("engine-model-backed-exact-commit: protected engine attestation does not match the evidenced engine commit");
    }
  }
  return blockers;
}

function printStatus(manifest) {
  const pending = manifest.gates.filter((gate) => !gate.ready);
  console.log(`Public release readiness for ${manifest.productName} ${manifest.candidateVersion}: ${manifest.publicRelease.state.toUpperCase()} (${manifest.gates.length - pending.length}/${manifest.gates.length} ready)`);
  for (const gate of manifest.gates) {
    console.log(`${gate.ready ? "READY" : "PENDING"} ${gate.id}: ${gate.title}`);
    if (!gate.ready) console.log(`  To unblock: ${gate.remediation}`);
  }
  if (pending.length) console.log("Status mode reports pending gates without authorizing a public release.");
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  let manifest;
  let packageJson;
  try {
    [manifest, packageJson] = await Promise.all([
      readFile(options.manifestPath, "utf8").then(JSON.parse),
      readFile(packagePath, "utf8").then(JSON.parse)
    ]);
  } catch (error) {
    console.error(`Invalid public-release readiness input: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const errors = validateManifest(manifest, packageJson);
  if (errors.length) {
    console.error("Invalid public-release readiness manifest:\n" + errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 2;
    return;
  }
  if (options.mode === "status") {
    printStatus(manifest);
    return;
  }
  const pending = manifest.gates.filter((gate) => !gate.ready);
  if (pending.length) {
    console.error(`PUBLIC RELEASE BLOCKED: ${pending.length} required gate(s) are pending for ${manifest.productName} ${manifest.candidateVersion}.`);
    for (const gate of pending) console.error(`- ${gate.id}: ${gate.remediation}`);
    console.error("Strict mode refused to build or publish the public release.");
    process.exitCode = 1;
    return;
  }
  const blockers = await implementationBlockers(manifest, packageJson, process.env);
  if (blockers.length) {
    console.error("PUBLIC RELEASE BLOCKED: readiness evidence is present, but implementation checks failed:\n" + blockers.map((blocker) => `- ${blocker}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`PUBLIC RELEASE READY: all ${manifest.gates.length} gates passed for ${manifest.productName} ${manifest.candidateVersion} on ${process.env.GITHUB_SHA}.`);
}

main();
