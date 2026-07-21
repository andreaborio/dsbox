import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function text(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("macOS package contract", () => {
  it("keeps the current DSBox identity and external engine delivery explicit", async () => {
    const contract = JSON.parse(await text("scripts/macos-package-contract.json"));
    const builder = await text("electron-builder.yml");
    const packageJson = JSON.parse(await text("package.json"));

    expect(contract).toMatchObject({
      schemaVersion: 1,
      productName: "DSBox",
      bundleIdentifier: "com.dsbox.desktop",
      executableName: "DSBox",
      architecture: "arm64",
      engineDelivery: "external"
    });
    expect(new Set(contract.forbiddenEmbeddedEngineExecutables)).toEqual(new Set([
      "hebrus", "hebrus-server", "hebrus-agent", "hebrus-bench", "hebrus-eval",
      "ds4", "ds4-server", "ds4-agent", "ds4-bench", "ds4-eval"
    ]));

    expect(builder).toMatch(/^appId: com\.dsbox\.desktop$/m);
    expect(builder).toMatch(/^productName: DSBox$/m);
    expect(builder).toMatch(/^artifactName: DSBox-\$\{version\}-macOS-\$\{arch\}\.\$\{ext\}$/m);
    expect(builder).toMatch(/^asar: true$/m);
    expect(builder).toMatch(/^  identity: "-"$/m);
    expect(builder).toMatch(/^        - arm64$/m);
    expect(builder).not.toMatch(/^(extraFiles|extraResources):/m);
    expect(packageJson.scripts["verify:mac"]).toBe("bash scripts/verify-macos-release.sh");
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
