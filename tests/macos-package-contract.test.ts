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
    const developmentBuilder = await text("electron-builder.dev.yml");
    const packageJson = JSON.parse(await text("package.json"));
    const verifier = await text("scripts/verify-macos-release.sh");

    expect(contract).toMatchObject({
      schemaVersion: 3,
      productName: "Hebrus Studio",
      packageName: "hebrus-studio",
      artifactBaseName: "Hebrus-Studio",
      bundleIdentifier: "com.dsbox.desktop",
      executableName: "Hebrus Studio",
      iconFile: "icon.icns",
      brandLogo: {
        source: "src/assets/hebrus-logo.png",
        appIcon: "build/icon.icns",
        archivePrefix: "/dist/assets/hebrus-logo-",
        sha256: "4be8949c73bd52e7abef58396dcd57f636165a8bb6cd6d536a600bcbf880594c"
      },
      architecture: "arm64",
      engineDelivery: "external",
      signing: {
        release: {
          identity: "Developer ID Application",
          hardenedRuntime: true,
          notarizedApp: true,
          notarizedAndStapledDmg: true,
          gatekeeperRequired: true
        },
        development: { identity: "adhoc", hardenedRuntime: false, notarized: false }
      },
      sbom: {
        format: "CycloneDX",
        specVersion: "1.5",
        componentType: "application",
        source: "package-lock.json",
        fileNameTemplate: "Hebrus-Studio-{version}-SBOM.cdx.json",
        licenseInventoryFileNameTemplate: "Hebrus-Studio-{version}-THIRD-PARTY-LICENSES.md"
      },
      provenance: {
        embeddedFile: "release-provenance.json",
        sourceFile: "build/release-provenance.json",
        schemaVersion: 2,
        developmentSchemaVersion: 1,
        workflow: "release-macos"
      },
      releaseAttestation: {
        schemaVersion: 1,
        fileNameTemplate: "Hebrus-Studio-{version}-Release-Attestation.json"
      },
      upgradeRollback: {
        schemaVersion: 2,
        legacyCommit: "595e9952c4fd1197de3aa3ccde66a5ddccddd397",
        reportFileNameTemplate: "Hebrus-Studio-{version}-Upgrade-Rollback-E2E.json",
        logFileNameTemplate: "Hebrus-Studio-{version}-Upgrade-Rollback-E2E.log"
      },
      developmentEvidence: {
        schemaVersion: 1,
        qualification: "development",
        directory: "development-evidence",
        reportFileNameTemplate: "Hebrus-Studio-{version}-Development-Upgrade-Rollback-E2E.json",
        logFileNameTemplate: "Hebrus-Studio-{version}-Development-Upgrade-Rollback-E2E.log"
      },
      requiredLegalNotices: [
        "LICENSE.txt",
        "THIRD_PARTY_NOTICES.md",
        "LICENSE.electron.txt",
        "LICENSES.chromium.html"
      ],
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
    expect(builder).toMatch(/^forceCodeSigning: true$/m);
    expect(builder).not.toMatch(/^\s*identity:/m);
    expect(builder).toMatch(/^  hardenedRuntime: true$/m);
    expect(builder).toMatch(/^  notarize: true$/m);
    expect(developmentBuilder).toContain("extends: ./electron-builder.yml");
    expect(developmentBuilder).toMatch(/^forceCodeSigning: false$/m);
    expect(developmentBuilder).toMatch(/^  identity: "-"$/m);
    expect(developmentBuilder).toMatch(/^  hardenedRuntime: false$/m);
    expect(developmentBuilder).toMatch(/^  notarize: false$/m);
    expect(builder).toMatch(/^  sign: true$/m);
    expect(developmentBuilder).toMatch(/^  sign: false$/m);
    expect(builder).toMatch(/^        - arm64$/m);
    expect(builder).not.toMatch(/^extraFiles:/m);
    expect(builder).toMatch(/^extraResources:\n(?:  - .+\n(?:    .+\n)*)+/m);
    expect(builder).toContain("from: build/release-provenance.json\n    to: release-provenance.json");
    expect(builder).toContain("from: LICENSE\n    to: LICENSE.txt");
    expect(builder).toContain("from: THIRD_PARTY_NOTICES.md\n    to: THIRD_PARTY_NOTICES.md");
    expect(builder).toContain("from: node_modules/electron/dist/LICENSE\n    to: LICENSE.electron.txt");
    expect(builder).toContain("from: node_modules/electron/dist/LICENSES.chromium.html\n    to: LICENSES.chromium.html");
    expect(packageJson.scripts["verify:mac"]).toBe("bash scripts/verify-macos-release.sh");
    expect(packageJson.scripts["verify:mac:dev"]).toBe("bash scripts/verify-macos-release.sh --development");
    expect(packageJson.scripts["release:sbom:validate"]).toBe("node scripts/validate-release-sbom.mjs");
    expect(packageJson.scripts["release:provenance"]).toContain("generate-release-provenance.mjs");
    expect(packageJson.scripts["release:attestation:create"]).toContain("create-release-attestation.mjs");
    expect(packageJson.scripts["release:attestation:validate"]).toContain("validate-release-attestation.mjs");
    expect(packageJson.scripts["release:checksums"]).toContain("create-release-checksums.mjs");
    expect(packageJson.scripts["build:icon"]).toBe("bash scripts/build-macos-icon.sh");
    expect(packageJson.scripts["build:provenance:dev"]).toContain("generate-development-provenance.mjs");
    expect(packageJson.scripts["build:legal-notices"]).toBe("node node_modules/electron/install.js");
    expect(packageJson.scripts["pack:mac"]).toContain("--config electron-builder.dev.yml --mac dir --arm64");
    expect(packageJson.scripts["dist:mac"]).toMatch(/^npm run build:legal-notices && npm run build:icon && /);
    expect(packageJson.scripts["dist:mac"]).not.toContain("electron-builder.dev.yml");
    expect(packageJson.scripts["dist:mac:dev"]).toContain("--config electron-builder.dev.yml --mac dmg --arm64");
    expect(packageJson.scripts["verify:upgrade-rollback:e2e:dev-dmg"]).toBe("bash scripts/run-upgrade-rollback-e2e.sh --development");
    expect(packageJson.scripts["development:e2e:report:validate"]).toBe("node scripts/validate-development-upgrade-rollback-report.mjs");
    expect(packageJson.name).toBe("hebrus-studio");
    expect(verifier).toContain('cmp -s "$CANONICAL_ICON" "$APP_PATH/Contents/Resources/$EXPECTED_ICON"');
    expect(verifier).toContain("requiredLegalNotices.join('\\n')");
    expect(verifier).toContain('Required legal notice is missing: $REQUIRED_NOTICE');
    expect(verifier).toContain("validateReleaseProvenance");
    expect(verifier).toContain("validate-release-checksums.mjs");
    expect(verifier).toContain("Authority=Developer ID Application:");
    expect(verifier).toContain('codesign --verify --verbose=2 "$ARTIFACT"');
    expect(verifier).toContain("Release DMG has no valid Apple signing team identifier.");
    expect(verifier).toContain("xcrun stapler validate");
    expect(verifier).toContain("spctl --assess --type execute");
    expect(verifier).toContain("HEBRUS_SIGNING_CERTIFICATE_COMMON_NAME");
    expect(verifier).toContain("--extract-certificates");
    expect(verifier).toContain("certificate SHA-1 does not match the protected release identity");
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

  it("keeps normal macOS CI on explicit development provenance", async () => {
    const ci = await text(".github/workflows/ci.yml");
    expect(ci).toContain("npm run pack:mac");
    expect(ci).toContain("npm run verify:mac:dev -- \"release/mac-arm64/Hebrus Studio.app\"");
    expect(ci).toContain("npm run verify:upgrade-rollback:e2e -- --source");
    expect(ci).not.toContain("npm run verify:mac -- \"release/mac-arm64/Hebrus Studio.app\"");
  });

  it("keeps development final-DMG evidence separate from public release evidence", async () => {
    const contract = JSON.parse(await text("scripts/macos-package-contract.json"));
    const runner = await text("scripts/run-upgrade-rollback-e2e.sh");
    const releaseWorkflow = await text(".github/workflows/release-macos.yml");
    const developmentStart = runner.indexOf('if [[ "$mode" == "--development" ]]');
    const releaseStart = runner.indexOf('\nversion="$(node -p', developmentStart);
    const developmentLane = runner.slice(developmentStart, releaseStart);

    expect(developmentStart).toBeGreaterThan(0);
    expect(releaseStart).toBeGreaterThan(developmentStart);
    expect(developmentLane).toContain('expected_commit="$(git -C "$repo_root" rev-parse HEAD)"');
    expect(developmentLane).toContain("run-development-dmg-upgrade-rollback-e2e.mjs");
    expect(developmentLane).toContain("validate-development-upgrade-rollback-report.mjs");
    expect(developmentLane).not.toContain("new_tree");
    expect(developmentLane).not.toContain("SBOM");
    expect(developmentLane).not.toContain("checksum");
    expect(contract.checksums.requiredFileNameTemplates).not.toContain(contract.developmentEvidence.reportFileNameTemplate);
    expect(contract.checksums.requiredFileNameTemplates).not.toContain(contract.developmentEvidence.logFileNameTemplate);
    expect(releaseWorkflow).not.toContain("development-evidence");
  });

  it("keeps public packaging on fail-closed Developer ID and outer-DMG notarization", async () => {
    const workflow = await text(".github/workflows/release-macos.yml");
    expect(workflow).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).toContain('Required release secret $secret_name is missing.');
    expect(workflow).toContain("xcrun notarytool submit \"$DMG\"");
    expect(workflow).toContain("environment: public-release");
    expect(workflow).toContain("--output-format json");
    expect(workflow).toContain("create-release-attestation.mjs");
    expect(workflow).toContain("validate-release-attestation.mjs");
    expect(workflow).toContain("Hebrus-Studio-${{ steps.version.outputs.version }}-Release-Attestation.json#Signing and notarization attestation");
    expect(workflow).toContain("timeout-minutes: 60");
    expect(workflow).toContain("codesign --verify --verbose=2 \"$DMG\"");
    expect(workflow).toContain("xcrun stapler staple \"$DMG\"");
    expect(workflow).toContain("xcrun stapler validate \"$DMG\"");
    const strict = workflow.indexOf("npm run release:readiness:strict");
    const preflight = workflow.indexOf("Require Developer ID and notarization credentials");
    const build = workflow.indexOf("npm run dist:mac");
    const outerNotary = workflow.indexOf("xcrun notarytool submit");
    const packageVerify = workflow.indexOf("npm run verify:mac");
    expect(strict).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(build);
    expect(build).toBeLessThan(outerNotary);
    expect(outerNotary).toBeLessThan(packageVerify);
  });

  it("keeps the local Gatekeeper exception out of the public install path", async () => {
    const installGuide = await text("docs/INSTALL-macOS.md");
    const publicSection = installGuide.slice(
      installGuide.indexOf("## If Gatekeeper rejects the public app"),
      installGuide.indexOf("## Local development build")
    );
    const developmentSection = installGuide.slice(installGuide.indexOf("## Local development build"));

    expect(publicSection).toContain("Do not remove quarantine");
    expect(publicSection).not.toContain("xattr -dr");
    expect(developmentSection).toMatch(/Control-click the app in\s+Finder/);
    expect(developmentSection).toContain('xattr -dr com.apple.quarantine "/Applications/Hebrus Studio.app"');
    expect(developmentSection).toMatch(/Never use this local\s+exception for a purported public release/);
  });
});
