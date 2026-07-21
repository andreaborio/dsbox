import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checker = path.resolve(import.meta.dirname, "../scripts/check-brand-boundaries.mjs");
const tokens = ["DSBox", "dsbox", "DS4", "ds4", "DwarfStar"] as const;
const classificationDefinitions = {
  "serialized/permanent": "Stable identifiers persisted on disk or on the wire.",
  compatibility: "Names retained for existing installations and integrations.",
  "historical-attribution": "Names preserved in history and attribution.",
  "migration-pending": "Internal source names awaiting mechanical cleanup."
};

function manifest(entries: Array<Record<string, unknown>>) {
  return {
    schemaVersion: 2,
    identityContract: { publicProductName: "Hebrus Studio", publicEngineName: "Hebrus" },
    scope: {
      tokens,
      excludedDirectories: [".git", "coverage", "dist", "dist-server", "node_modules", "release"],
      excludedPaths: [".git", "scripts/brand-boundary.json", "scripts/check-brand-boundaries.mjs"]
    },
    classificationDefinitions,
    refreshPolicy: {
      reductions: "node scripts/check-brand-boundaries.mjs --refresh",
      existingIncrease: "node scripts/check-brand-boundaries.mjs --refresh --accept-increase PATH:TOKEN",
      newGroup: "node scripts/check-brand-boundaries.mjs --refresh --classify 'PATH:TOKEN=CLASSIFICATION|REASON'"
    },
    entries
  };
}

function run(root: string, args: string[] = []) {
  return execFileSync(process.execPath, [checker, "--root", root, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function failure(root: string, args: string[] = []) {
  try {
    run(root, args);
    throw new Error("brand audit unexpectedly passed");
  } catch (error) {
    const result = error as { stderr?: string | Buffer };
    return String(result.stderr ?? error);
  }
}

describe("brand-boundary audit", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hebrus-studio-brand-audit-"));
    await mkdir(path.join(root, "scripts"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(tokens)("rejects a new file containing the separately scoped %s token", async (token) => {
    await writeFile(path.join(root, "scripts/brand-boundary.json"), `${JSON.stringify(manifest([]), null, 2)}\n`);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/new.ts"), `export const legacy = ${JSON.stringify(token)};\n`);

    expect(failure(root)).toContain(`unclassified brand token group: src/new.ts:${token}`);
  });

  it("rejects an increase in an existing exact file and token group", async () => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/legacy.ts"), "ds4 ds4\n");
    const entries = [{
      path: "src/legacy.ts",
      token: "ds4",
      classification: "compatibility",
      reason: "Legacy engine alias.",
      maximum: 1
    }];
    await writeFile(path.join(root, "scripts/brand-boundary.json"), `${JSON.stringify(manifest(entries), null, 2)}\n`);

    expect(failure(root)).toContain("brand token group increased: src/legacy.ts:ds4 (1 -> 2)");
  });

  it("rejects a different token in an otherwise classified file", async () => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/legacy.ts"), "DSBox dsbox\n");
    const entries = [{
      path: "src/legacy.ts",
      token: "DSBox",
      classification: "compatibility",
      reason: "Legacy product name.",
      maximum: 1
    }];
    await writeFile(path.join(root, "scripts/brand-boundary.json"), `${JSON.stringify(manifest(entries), null, 2)}\n`);

    expect(failure(root)).toContain("unclassified brand token group: src/legacy.ts:dsbox");
  });

  it("refreshes reductions deterministically and requires explicit new-group classification", async () => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/legacy.ts"), "ds4\n");
    const entries = [{
      path: "src/legacy.ts",
      token: "ds4",
      classification: "compatibility",
      reason: "Legacy engine alias.",
      maximum: 2
    }];
    const manifestPath = path.join(root, "scripts/brand-boundary.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest(entries), null, 2)}\n`);

    run(root, ["--refresh"]);
    const once = await readFile(manifestPath, "utf8");
    expect(JSON.parse(once).entries[0].maximum).toBe(1);
    run(root, ["--refresh"]);
    expect(await readFile(manifestPath, "utf8")).toBe(once);

    await writeFile(path.join(root, "src/new.ts"), "DS4\n");
    expect(failure(root, ["--refresh"]))
      .toContain("new group requires --classify 'src/new.ts:DS4=CLASSIFICATION|REASON'");
    run(root, [
      "--refresh",
      "--classify",
      "src/new.ts:DS4=compatibility|Legacy command fixture."
    ]);
    const updated = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(updated.entries).toContainEqual({
      path: "src/new.ts",
      token: "DS4",
      classification: "compatibility",
      reason: "Legacy command fixture.",
      maximum: 1
    });
  });

  it("requires an exact authorization before refreshing an increase", async () => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/legacy.ts"), "dsbox dsbox\n");
    const entries = [{
      path: "src/legacy.ts",
      token: "dsbox",
      classification: "serialized/permanent",
      reason: "Persisted storage namespace.",
      maximum: 1
    }];
    const manifestPath = path.join(root, "scripts/brand-boundary.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest(entries), null, 2)}\n`);

    expect(failure(root, ["--refresh"]))
      .toContain("increase requires --accept-increase src/legacy.ts:dsbox (1 -> 2)");
    run(root, ["--refresh", "--accept-increase", "src/legacy.ts:dsbox"]);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).entries[0].maximum).toBe(2);
  });
});
