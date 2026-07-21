import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import parseSpdxExpression from "spdx-expression-parse";

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeTextAtomic(filePath, contents) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  await writeFile(temporaryPath, contents, { flag: "wx" });
  await rename(temporaryPath, absolutePath);
}

export async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function assertSpdxExpression(value, label = "license") {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is empty or not a string`);
  }
  const expression = value.trim();
  if (/^(?:UNLICENSED|UNKNOWN|NOASSERTION|NONE)$/i.test(expression) || /^SEE LICEN[CS]E/i.test(expression)) {
    throw new Error(`${label} is not an identifiable SPDX expression: ${expression}`);
  }
  try {
    parseSpdxExpression(expression);
  } catch (error) {
    throw new Error(`${label} is not an identifiable SPDX expression: ${expression} (${error.message})`);
  }
  return expression;
}

export function cycloneDxLicensesFromPackageMetadata(value, label) {
  const candidates = Array.isArray(value) ? value : [value];
  if (candidates.length === 0) throw new Error(`${label} has no license metadata`);
  return candidates.map((candidate, index) => {
    const raw = typeof candidate === "string" ? candidate : candidate?.type;
    const expression = assertSpdxExpression(raw, `${label}[${index}]`);
    return /\b(?:AND|OR|WITH)\b|[()]/.test(expression)
      ? { expression }
      : { license: { id: expression } };
  });
}

export function cycloneDxLicenseExpression(entry, label = "license") {
  if (typeof entry?.expression === "string") return assertSpdxExpression(entry.expression, label);
  if (typeof entry?.license?.id === "string") return assertSpdxExpression(entry.license.id, label);
  throw new Error(`${label} must use a recognized SPDX id or expression`);
}

export function versioned(template, version) {
  return template.replaceAll("{version}", version);
}

export function validateReleaseProvenance(provenance, { packageJson, contract, expectedCommit, expectedTag } = {}) {
  const errors = [];
  const requireValue = (condition, message) => {
    if (!condition) errors.push(message);
  };
  requireValue(provenance?.schemaVersion === contract?.provenance?.schemaVersion, `schemaVersion must be ${contract?.provenance?.schemaVersion}`);
  requireValue(provenance?.subject?.name === contract?.productName, `subject.name must be ${contract?.productName}`);
  requireValue(provenance?.subject?.packageName === packageJson?.name, `subject.packageName must be ${packageJson?.name}`);
  requireValue(provenance?.subject?.version === packageJson?.version, `subject.version must be ${packageJson?.version}`);
  requireValue(provenance?.subject?.platform === "macOS", "subject.platform must be macOS");
  requireValue(provenance?.subject?.architecture === contract?.architecture, `subject.architecture must be ${contract?.architecture}`);
  requireValue(/^[a-f0-9]{40}$/i.test(provenance?.source?.commit ?? ""), "source.commit must be a full commit id");
  requireValue(provenance?.source?.tag === `v${packageJson?.version}`, `source.tag must be v${packageJson?.version}`);
  requireValue(provenance?.source?.treeState === "clean", "source.treeState must be clean");
  requireValue(/^[^/]+\/[^/]+$/.test(provenance?.source?.repository ?? ""), "source.repository must be owner/repository");
  requireValue(provenance?.build?.provider === "github-actions", "build.provider must be github-actions");
  requireValue(provenance?.build?.workflow === contract?.provenance?.workflow, `build.workflow must be ${contract?.provenance?.workflow}`);
  requireValue(provenance?.build?.event === "push", "build.event must be push");
  requireValue(provenance?.build?.refType === "tag", "build.refType must be tag");
  requireValue(provenance?.build?.githubActions === true, "build.githubActions must be true");
  requireValue(/^\d+$/.test(provenance?.build?.runId ?? ""), "build.runId must be numeric");
  requireValue(/^\d+$/.test(provenance?.build?.runAttempt ?? ""), "build.runAttempt must be numeric");
  if (expectedCommit) requireValue(provenance?.source?.commit === expectedCommit, `source.commit must equal expected commit ${expectedCommit}`);
  if (expectedTag) requireValue(provenance?.source?.tag === expectedTag, `source.tag must equal expected tag ${expectedTag}`);
  if (errors.length) throw new Error(`Invalid release provenance:\n${[...new Set(errors)].map((error) => `- ${error}`).join("\n")}`);
  return provenance;
}
