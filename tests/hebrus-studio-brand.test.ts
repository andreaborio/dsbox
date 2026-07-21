import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

async function text(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Hebrus Studio public identity", () => {
  it("uses the unmodified project-supplied logo and adds depth only in CSS", async () => {
    const [logo, component, styles] = await Promise.all([
      readFile(path.join(root, "src/assets/hebrus-logo.png")),
      text("src/components/ui.tsx"),
      text("src/styles.css")
    ]);

    expect(createHash("sha256").update(logo).digest("hex"))
      .toBe("4be8949c73bd52e7abef58396dcd57f636165a8bb6cd6d536a600bcbf880594c");
    expect(component).toContain('import hebrusLogo from "../assets/hebrus-logo.png"');
    expect(component).toContain('className="brand-mark__image"');
    expect(styles).toMatch(/\.brand-mark__image\s*\{[\s\S]*drop-shadow\(/);
  });

  it("uses the new name across the browser and desktop entry points", async () => {
    const [html, desktop, packageJson] = await Promise.all([
      text("index.html"),
      text("desktop/main.cjs"),
      text("package.json")
    ]);

    expect(html).toContain("<title>Hebrus Studio</title>");
    expect(desktop).toContain('const PRODUCT_NAME = "Hebrus Studio"');
    expect(JSON.parse(packageJson)).toMatchObject({
      name: "hebrus-studio",
      author: "Hebrus Studio contributors"
    });
  });

  it("retains all state and wire identifiers needed by existing DSBox installs", async () => {
    const [desktop, contract, theme, onboarding, chat, api] = await Promise.all([
      text("desktop/main.cjs"),
      text("scripts/macos-package-contract.json"),
      text("src/theme/runtime.ts"),
      text("src/lib/onboarding-preference.ts"),
      text("src/lib/chat-session.ts"),
      text("src/lib/api.ts")
    ]);

    expect(desktop).toContain('path.join(app.getPath("appData"), "DSBox")');
    expect(desktop).toContain('process.env.DSBOX_PORT');
    expect(JSON.parse(contract).compatibility).toEqual({
      legacyProductName: "DSBox",
      legacyUserDataDirectoryName: "DSBox",
      stateRoot: "~/.dsbox",
      environmentPrefix: "DSBOX_",
      storageKeyPrefix: "dsbox:"
    });
    expect(theme).toContain('"dsbox:appearance-theme:v1"');
    expect(onboarding).toContain('"dsbox:onboarding-state:v2"');
    expect(chat).toContain('"dsbox:chat-threads:v1"');
    expect(api).toContain('"x-dsbox-control"');
  });
});
