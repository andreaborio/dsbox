import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function text(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("macOS package contract", () => {
  it("publishes the Hebrus Studio identity without breaking DSBox state", async () => {
    const contract = JSON.parse(await text("scripts/macos-package-contract.json"));
    const builder = await text("electron-builder.yml");
    const packageJson = JSON.parse(await text("package.json"));

    expect(contract).toMatchObject({
      schemaVersion: 2,
      productName: "Hebrus Studio",
      packageName: "hebrus-studio",
      artifactBaseName: "Hebrus-Studio",
      bundleIdentifier: "com.dsbox.desktop",
      executableName: "Hebrus Studio",
      iconFile: "icon.icns",
      architecture: "arm64",
      engineDelivery: "external",
      compatibility: {
        legacyProductName: "DSBox",
        legacyUserDataDirectoryName: "DSBox",
        stateRoot: "~/.dsbox",
        environmentPrefix: "DSBOX_",
        storageKeyPrefix: "dsbox:"
      }
    });
    expect(new Set(contract.forbiddenEmbeddedEngineExecutables)).toEqual(new Set([
      "hebrus", "hebrus-server", "hebrus-agent", "hebrus-bench", "hebrus-eval",
      "ds4", "ds4-server", "ds4-agent", "ds4-bench", "ds4-eval"
    ]));

    expect(builder).toMatch(/^appId: com\.dsbox\.desktop$/m);
    expect(builder).toMatch(/^productName: Hebrus Studio$/m);
    expect(builder).toMatch(/^artifactName: Hebrus-Studio-\$\{version\}-macOS-\$\{arch\}\.\$\{ext\}$/m);
    expect(builder).toMatch(/^asar: true$/m);
    expect(builder).toMatch(/^  identity: "-"$/m);
    expect(builder).toMatch(/^        - arm64$/m);
    expect(builder).not.toMatch(/^(extraFiles|extraResources):/m);
    expect(packageJson.scripts["verify:mac"]).toBe("bash scripts/verify-macos-release.sh");
    expect(packageJson.name).toBe("hebrus-studio");
  });

  it("pins Electron to the legacy user-data directory before setting the new name", async () => {
    const desktop = await text("desktop/main.cjs");
    const legacyPath = desktop.indexOf('path.join(app.getPath("appData"), "DSBox")');
    const overrideGuard = desktop.indexOf("if (!HAS_USER_DATA_OVERRIDE)");
    const setUserData = desktop.indexOf('app.setPath("userData", LEGACY_USER_DATA_PATH)');
    const setName = desktop.indexOf("app.setName(PRODUCT_NAME)");

    expect(legacyPath).toBeGreaterThanOrEqual(0);
    expect(overrideGuard).toBeGreaterThan(legacyPath);
    expect(setUserData).toBeGreaterThan(overrideGuard);
    expect(setName).toBeGreaterThan(setUserData);
  });

  it("packages only the UI, control plane, desktop shell, and metadata", async () => {
    const builder = await text("electron-builder.yml");
    const filesBlock = builder.match(/^files:\n((?:  - .+\n)+)/m)?.[1]
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, ""));

    expect(filesBlock).toEqual([
      "dist/**/*",
      "dist-server/**/*",
      "desktop/**/*",
      "package.json"
    ]);
  });
});
