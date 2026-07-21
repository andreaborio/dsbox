import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = "scripts/brand-boundary.json";
const TOKENS = ["DSBox", "dsbox", "DS4", "ds4", "DwarfStar"];
const TOKEN_ORDER = new Map(TOKENS.map((token, index) => [token, index]));
const CLASSIFICATIONS = [
  "serialized/permanent",
  "compatibility",
  "historical-attribution",
  "migration-pending"
];

function usage() {
  return [
    "Usage: node scripts/check-brand-boundaries.mjs [--check] [--root PATH] [--manifest PATH]",
    "       node scripts/check-brand-boundaries.mjs --refresh [--root PATH] [--manifest PATH]",
    "         [--accept-increase PATH:TOKEN]",
    "         [--classify PATH:TOKEN=CLASSIFICATION|REASON]",
    "",
    "--check rejects new groups and increases without changing the manifest.",
    "--refresh lowers exact maxima and removes empty groups deterministically.",
    "An increase or new group needs one exact, single-use authorization."
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    mode: "check",
    root: DEFAULT_ROOT,
    manifest: null,
    acceptedIncreases: [],
    classifications: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.mode = "check";
    else if (argument === "--refresh") options.mode = "refresh";
    else if (["--root", "--manifest", "--accept-increase", "--classify"].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--root") options.root = path.resolve(value);
      else if (argument === "--manifest") options.manifest = value;
      else if (argument === "--accept-increase") options.acceptedIncreases.push(value);
      else options.classifications.push(value);
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}\n${usage()}`);
    }
  }
  if (options.mode !== "refresh" && (options.acceptedIncreases.length || options.classifications.length)) {
    throw new Error("--accept-increase and --classify require --refresh");
  }
  const manifestArgument = options.manifest || DEFAULT_MANIFEST;
  options.manifest = path.isAbsolute(manifestArgument)
    ? manifestArgument
    : path.join(options.root, manifestArgument);
  return options;
}

function exactKeys(value, expected, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${context} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function normalizedRelativePath(value, context) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) {
    throw new Error(`${context} must be a non-empty relative path`);
  }
  const normalized = value.split("\\").join("/");
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${context} escapes the repository root`);
  }
  return normalized;
}

function groupKey(filePath, token) {
  return `${filePath}:${token}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left, right) {
  return compareText(left.path, right.path)
    || TOKEN_ORDER.get(left.token) - TOKEN_ORDER.get(right.token);
}

function validateManifest(manifest) {
  exactKeys(
    manifest,
    ["schemaVersion", "identityContract", "scope", "classificationDefinitions", "refreshPolicy", "entries"],
    "manifest"
  );
  if (manifest.schemaVersion !== 2) throw new Error("manifest.schemaVersion must be 2");
  exactKeys(manifest.identityContract, ["publicProductName", "publicEngineName"], "identityContract");
  if (manifest.identityContract.publicProductName !== "Hebrus Studio"
      || manifest.identityContract.publicEngineName !== "Hebrus") {
    throw new Error("identityContract must preserve the canonical Hebrus Studio/Hebrus names");
  }
  exactKeys(manifest.scope, ["tokens", "excludedDirectories", "excludedPaths"], "scope");
  if (JSON.stringify(manifest.scope.tokens) !== JSON.stringify(TOKENS)) {
    throw new Error(`scope.tokens must be exactly ${JSON.stringify(TOKENS)}`);
  }
  for (const field of ["excludedDirectories", "excludedPaths"]) {
    if (!Array.isArray(manifest.scope[field]) || !manifest.scope[field].every((item) => typeof item === "string" && item)) {
      throw new Error(`scope.${field} must contain non-empty strings`);
    }
    const sorted = [...manifest.scope[field]].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(manifest.scope[field])) {
      throw new Error(`scope.${field} must be sorted`);
    }
    if (new Set(manifest.scope[field]).size !== manifest.scope[field].length) {
      throw new Error(`scope.${field} must not contain duplicates`);
    }
  }
  exactKeys(manifest.classificationDefinitions, CLASSIFICATIONS, "classificationDefinitions");
  for (const classification of CLASSIFICATIONS) {
    if (typeof manifest.classificationDefinitions[classification] !== "string"
        || !manifest.classificationDefinitions[classification].trim()) {
      throw new Error(`classificationDefinitions.${classification} must be non-empty`);
    }
  }
  exactKeys(manifest.refreshPolicy, ["reductions", "existingIncrease", "newGroup"], "refreshPolicy");
  if (!Object.values(manifest.refreshPolicy).every((value) => typeof value === "string" && value.trim())) {
    throw new Error("refreshPolicy values must be non-empty strings");
  }
  if (!Array.isArray(manifest.entries)) throw new Error("manifest.entries must be an array");

  const seen = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    exactKeys(entry, ["path", "token", "classification", "reason", "maximum"], `entries[${index}]`);
    entry.path = normalizedRelativePath(entry.path, `entries[${index}].path`);
    if (!TOKENS.includes(entry.token)) throw new Error(`entries[${index}].token is outside scope`);
    if (!CLASSIFICATIONS.includes(entry.classification)) {
      throw new Error(`entries[${index}].classification is invalid`);
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error(`entries[${index}].reason must be non-empty`);
    }
    if (!Number.isInteger(entry.maximum) || entry.maximum < 1) {
      throw new Error(`entries[${index}].maximum must be a positive integer`);
    }
    const key = groupKey(entry.path, entry.token);
    if (seen.has(key)) throw new Error(`duplicate manifest group: ${key}`);
    seen.add(key);
  }
  const sorted = [...manifest.entries].sort(compareEntries);
  if (JSON.stringify(sorted) !== JSON.stringify(manifest.entries)) {
    throw new Error("manifest.entries must be sorted by path and token order");
  }
}

async function filesIn(directory, root, excludedDirectories) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        files.push(...await filesIn(absolute, root, excludedDirectories));
      }
    } else if (entry.isFile()) {
      files.push({ absolute, relative });
    }
  }
  return files;
}

function countToken(text, token) {
  return text.split(token).length - 1;
}

async function scan(root, scope) {
  const excludedDirectories = new Set(scope.excludedDirectories);
  const excludedPaths = new Set(scope.excludedPaths);
  const observed = new Map();
  for (const { absolute, relative } of await filesIn(root, root, excludedDirectories)) {
    if (excludedPaths.has(relative)) continue;
    const contents = await readFile(absolute).catch(() => null);
    if (!contents || contents.includes(0)) continue;
    const text = contents.toString("utf8");
    for (const token of TOKENS) {
      const count = countToken(text, token);
      if (count > 0) observed.set(groupKey(relative, token), { path: relative, token, count });
    }
  }
  return observed;
}

function parseGroupReference(value, option) {
  const token = TOKENS.find((candidate) => value.endsWith(`:${candidate}`));
  if (!token) throw new Error(`${option} must end in one scoped token: ${TOKENS.join(", ")}`);
  const filePath = normalizedRelativePath(value.slice(0, -(token.length + 1)), option);
  return { path: filePath, token, key: groupKey(filePath, token) };
}

function parseClassification(value) {
  const equals = value.indexOf("=");
  const separator = value.indexOf("|", equals + 1);
  if (equals < 1 || separator < equals + 2) {
    throw new Error("--classify must be PATH:TOKEN=CLASSIFICATION|REASON");
  }
  const reference = parseGroupReference(value.slice(0, equals), "--classify");
  const classification = value.slice(equals + 1, separator);
  const reason = value.slice(separator + 1).trim();
  if (!CLASSIFICATIONS.includes(classification)) {
    throw new Error(`--classify uses an invalid classification: ${classification}`);
  }
  if (!reason) throw new Error("--classify requires a non-empty reason");
  return { ...reference, classification, reason };
}

function summarize(manifest, observed, reductions) {
  const entries = new Map(manifest.entries.map((entry) => [groupKey(entry.path, entry.token), entry]));
  const totals = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, 0]));
  let total = 0;
  for (const [key, group] of observed) {
    total += group.count;
    const entry = entries.get(key);
    if (entry) totals[entry.classification] += group.count;
  }
  const breakdown = CLASSIFICATIONS.map((classification) => `${classification}=${totals[classification]}`).join(", ");
  return `Hebrus Studio brand boundary verified: ${total} occurrence(s) in ${observed.size} exact group(s); ${reductions} reduction(s); ${breakdown}.`;
}

function check(manifest, observed) {
  const entries = new Map(manifest.entries.map((entry) => [groupKey(entry.path, entry.token), entry]));
  const violations = [];
  let reductions = 0;
  for (const [key, group] of observed) {
    const entry = entries.get(key);
    if (!entry) violations.push(`unclassified brand token group: ${key} (${group.count})`);
    else if (group.count > entry.maximum) {
      violations.push(`brand token group increased: ${key} (${entry.maximum} -> ${group.count})`);
    } else if (group.count < entry.maximum) reductions += 1;
  }
  for (const entry of manifest.entries) {
    if (!observed.has(groupKey(entry.path, entry.token))) reductions += 1;
  }
  return { violations, reductions };
}

async function refresh(manifest, observed, options) {
  const acceptedIncreases = new Map();
  for (const value of options.acceptedIncreases) {
    const reference = parseGroupReference(value, "--accept-increase");
    if (acceptedIncreases.has(reference.key)) throw new Error(`duplicate --accept-increase: ${reference.key}`);
    acceptedIncreases.set(reference.key, false);
  }
  const classifications = new Map();
  for (const value of options.classifications) {
    const classification = parseClassification(value);
    if (classifications.has(classification.key)) throw new Error(`duplicate --classify: ${classification.key}`);
    classifications.set(classification.key, { ...classification, used: false });
  }

  const oldEntries = new Map(manifest.entries.map((entry) => [groupKey(entry.path, entry.token), entry]));
  const nextEntries = [];
  const violations = [];
  for (const [key, group] of [...observed.entries()].sort((left, right) => compareEntries(left[1], right[1]))) {
    const oldEntry = oldEntries.get(key);
    if (oldEntry) {
      if (group.count > oldEntry.maximum) {
        if (!acceptedIncreases.has(key)) {
          violations.push(`increase requires --accept-increase ${key} (${oldEntry.maximum} -> ${group.count})`);
          continue;
        }
        acceptedIncreases.set(key, true);
      }
      nextEntries.push({ ...oldEntry, maximum: group.count });
      continue;
    }
    const authorization = classifications.get(key);
    if (!authorization) {
      violations.push(`new group requires --classify '${key}=CLASSIFICATION|REASON' (${group.count})`);
      continue;
    }
    authorization.used = true;
    nextEntries.push({
      path: group.path,
      token: group.token,
      classification: authorization.classification,
      reason: authorization.reason,
      maximum: group.count
    });
  }
  for (const [key, used] of acceptedIncreases) {
    if (!used) violations.push(`unused --accept-increase authorization: ${key}`);
  }
  for (const [key, authorization] of classifications) {
    if (!authorization.used) violations.push(`unused --classify authorization: ${key}`);
  }
  if (violations.length) return violations;

  manifest.entries = nextEntries.sort(compareEntries);
  validateManifest(manifest);
  await writeFile(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return [];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  validateManifest(manifest);
  const observed = await scan(options.root, manifest.scope);
  if (options.mode === "refresh") {
    const violations = await refresh(manifest, observed, options);
    if (violations.length) {
      console.error(`Hebrus Studio brand-boundary refresh failed:\n${violations.map((line) => `- ${line}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`Updated ${path.relative(options.root, options.manifest)} deterministically.`);
  }
  const result = check(manifest, observed);
  if (result.violations.length) {
    console.error(`Hebrus Studio brand-boundary audit failed:\n${result.violations.map((line) => `- ${line}`).join("\n")}`);
    process.exit(1);
  }
  console.log(summarize(manifest, observed, result.reductions));
}

main().catch((error) => {
  console.error(`Hebrus Studio brand-boundary audit failed:\n- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
