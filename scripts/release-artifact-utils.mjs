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

export function packageNameFromLockPath(packagePath) {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) throw new Error(`Unsupported package-lock path: ${packagePath}`);
  const name = packagePath.slice(index + marker.length);
  if (!name || name.includes("/node_modules/")) throw new Error(`Could not derive package name from lock path: ${packagePath}`);
  return name;
}

export function lockComponentRef(packagePath) {
  return `hebrus:package-lock:${encodeURIComponent(packagePath)}`;
}

function lockDependencyNames(metadata, isRoot) {
  return Object.keys({
    ...(metadata?.dependencies ?? {}),
    ...(isRoot ? metadata?.devDependencies ?? {} : {}),
    ...(metadata?.optionalDependencies ?? {}),
    ...(metadata?.peerDependencies ?? {})
  }).sort();
}

function resolveLockedDependency(packages, parentPath, dependencyName) {
  let current = parentPath;
  while (true) {
    const candidate = current
      ? `${current}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (!current) return null;
    const parentMarker = current.lastIndexOf("/node_modules/");
    current = parentMarker >= 0 ? current.slice(0, parentMarker) : "";
  }
}

export function lockDependencyGraph(lock, rootRef) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("package-lock.json must contain a packages object");
  }
  const packagePaths = Object.keys(packages).filter(Boolean).sort();
  const refs = new Map(packagePaths.map((packagePath) => [packagePath, lockComponentRef(packagePath)]));
  const dependencyNode = (packagePath, metadata, ref) => {
    const dependsOn = [];
    for (const dependencyName of lockDependencyNames(metadata, packagePath === "")) {
      const resolved = resolveLockedDependency(packages, packagePath, dependencyName);
      if (!resolved) {
        const optional = Object.hasOwn(metadata?.optionalDependencies ?? {}, dependencyName)
          || metadata?.peerDependenciesMeta?.[dependencyName]?.optional === true;
        if (optional) continue;
        throw new Error(`${packagePath || "<root>"} dependency ${dependencyName} has no locked package path`);
      }
      dependsOn.push(refs.get(resolved));
    }
    return { ref, dependsOn: [...new Set(dependsOn)].sort() };
  };
  return [
    dependencyNode("", packages[""] ?? {}, rootRef),
    ...packagePaths.map((packagePath) => dependencyNode(packagePath, packages[packagePath], refs.get(packagePath)))
  ];
}

export function validateReleaseProvenance(provenance, {
  packageJson,
  contract,
  expectedCommit,
  expectedTag,
  expectedSigning
} = {}) {
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
  const signing = provenance?.authorization?.signing;
  requireValue(/^[a-f0-9]{64}$/i.test(provenance?.authorization?.readinessManifestSha256 ?? ""), "authorization.readinessManifestSha256 must be a SHA-256 digest");
  requireValue(typeof signing?.certificateCommonName === "string" && signing.certificateCommonName.startsWith("Developer ID Application:"), "authorization.signing.certificateCommonName must name a Developer ID Application certificate");
  requireValue(/^[a-f0-9]{40}$/i.test(signing?.certificateSha1 ?? ""), "authorization.signing.certificateSha1 must be a SHA-1 fingerprint");
  requireValue(/^[A-Z0-9]{10}$/.test(signing?.teamIdentifier ?? ""), "authorization.signing.teamIdentifier must be a 10-character Apple team id");
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(provenance?.authorization?.notarizationQualificationSubmissionId ?? ""), "authorization.notarizationQualificationSubmissionId must be a UUID");
  if (expectedCommit) requireValue(provenance?.source?.commit === expectedCommit, `source.commit must equal expected commit ${expectedCommit}`);
  if (expectedTag) requireValue(provenance?.source?.tag === expectedTag, `source.tag must equal expected tag ${expectedTag}`);
  if (expectedSigning) {
    requireValue(signing?.certificateCommonName === expectedSigning.certificateCommonName, "authorized certificate common name does not match the protected expectation");
    requireValue(signing?.certificateSha1?.toLowerCase() === expectedSigning.certificateSha1?.toLowerCase(), "authorized certificate SHA-1 does not match the protected expectation");
    requireValue(signing?.teamIdentifier === expectedSigning.teamIdentifier, "authorized Apple team id does not match the protected expectation");
  }
  if (errors.length) throw new Error(`Invalid release provenance:\n${[...new Set(errors)].map((error) => `- ${error}`).join("\n")}`);
  return provenance;
}

export function validateReleaseAttestation(attestation, {
  packageJson,
  contract,
  provenance,
  provenanceSha256,
  dmgSha256,
  expectedCommit,
  expectedTag
} = {}) {
  const errors = [];
  const requireValue = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const expectedDmg = `${contract?.artifactBaseName}-${packageJson?.version}-macOS-${contract?.architecture}.dmg`;
  const expectedSigning = provenance?.authorization?.signing;
  requireValue(attestation?.schemaVersion === contract?.releaseAttestation?.schemaVersion, `schemaVersion must be ${contract?.releaseAttestation?.schemaVersion}`);
  requireValue(attestation?.product?.name === contract?.productName, `product.name must be ${contract?.productName}`);
  requireValue(attestation?.product?.version === packageJson?.version, `product.version must be ${packageJson?.version}`);
  requireValue(attestation?.product?.architecture === contract?.architecture, `product.architecture must be ${contract?.architecture}`);
  requireValue(attestation?.source?.commit === provenance?.source?.commit, "attestation source commit does not match provenance");
  requireValue(attestation?.source?.tag === provenance?.source?.tag, "attestation source tag does not match provenance");
  requireValue(attestation?.provenance?.sha256 === provenanceSha256, "attestation provenance SHA-256 mismatch");
  requireValue(attestation?.artifacts?.dmg?.fileName === expectedDmg, `attestation DMG filename must be ${expectedDmg}`);
  requireValue(attestation?.artifacts?.dmg?.sha256 === dmgSha256, "attestation DMG SHA-256 mismatch");
  for (const target of ["application", "dmg"]) {
    const actual = attestation?.signing?.[target];
    requireValue(actual?.certificateCommonName === expectedSigning?.certificateCommonName, `${target} certificate common name does not match provenance authorization`);
    requireValue(actual?.certificateSha1?.toLowerCase() === expectedSigning?.certificateSha1?.toLowerCase(), `${target} certificate SHA-1 does not match provenance authorization`);
    requireValue(actual?.teamIdentifier === expectedSigning?.teamIdentifier, `${target} Apple team id does not match provenance authorization`);
  }
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attestation?.notarization?.submissionId ?? ""), "notarization submissionId must be a UUID");
  requireValue(attestation?.notarization?.status === "Accepted", "notarization status must be Accepted");
  requireValue(attestation?.notarization?.dmgStapled === true, "DMG stapling must be verified");
  requireValue(attestation?.notarization?.applicationGatekeeperAccepted === true, "application Gatekeeper acceptance must be verified");
  if (expectedCommit) requireValue(attestation?.source?.commit === expectedCommit, `attestation source commit must equal ${expectedCommit}`);
  if (expectedTag) requireValue(attestation?.source?.tag === expectedTag, `attestation source tag must equal ${expectedTag}`);
  if (errors.length) throw new Error(`Invalid release attestation:\n${[...new Set(errors)].map((error) => `- ${error}`).join("\n")}`);
  return attestation;
}

export function validateDevelopmentProvenance(provenance, { packageJson, contract, expectedCommit } = {}) {
  const errors = [];
  const requireValue = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const hasOnlyKeys = (value, keys) => value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  requireValue(hasOnlyKeys(provenance, ["schemaVersion", "subject", "source", "build"]), "development provenance contains unexpected top-level fields");
  requireValue(hasOnlyKeys(provenance?.subject, ["name", "packageName", "version", "platform", "architecture"]), "development provenance subject contains unexpected fields");
  requireValue(hasOnlyKeys(provenance?.source, ["commit", "tag", "treeState"]), "development provenance source contains unexpected fields");
  requireValue(hasOnlyKeys(provenance?.build, ["provider", "workflow"]), "development provenance build contains unexpected fields");
  requireValue(provenance?.schemaVersion === contract?.provenance?.developmentSchemaVersion, `schemaVersion must be ${contract?.provenance?.developmentSchemaVersion}`);
  requireValue(provenance?.subject?.name === contract?.productName, `subject.name must be ${contract?.productName}`);
  requireValue(provenance?.subject?.packageName === packageJson?.name, `subject.packageName must be ${packageJson?.name}`);
  requireValue(provenance?.subject?.version === packageJson?.version, `subject.version must be ${packageJson?.version}`);
  requireValue(provenance?.subject?.platform === "macOS", "subject.platform must be macOS");
  requireValue(provenance?.subject?.architecture === contract?.architecture, `subject.architecture must be ${contract?.architecture}`);
  requireValue(/^[a-f0-9]{40}$/i.test(provenance?.source?.commit ?? ""), "source.commit must be a full commit id");
  requireValue(provenance?.source?.tag === null, "source.tag must be null for development provenance");
  requireValue(provenance?.source?.treeState === "development", "source.treeState must be development");
  requireValue(provenance?.build?.provider === "local-development", "build.provider must be local-development");
  requireValue(provenance?.build?.workflow === "local-development", "build.workflow must be local-development");
  if (expectedCommit) requireValue(provenance?.source?.commit === expectedCommit, `source.commit must equal current commit ${expectedCommit}`);
  if (errors.length) throw new Error(`Invalid development provenance:\n${[...new Set(errors)].map((error) => `- ${error}`).join("\n")}`);
  return provenance;
}
