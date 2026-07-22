import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

async function text(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Hebrus Studio public identity", () => {
  it("uses the temporary H mark instead of the old logo asset", async () => {
    const [component, styles] = await Promise.all([
      text("src/components/ui.tsx"),
      text("src/styles.css")
    ]);

    expect(component).not.toContain("hebrus-logo.png");
    expect(component).toContain('className="brand-mark__glyph"');
    expect(component).toContain(">H<");
    expect(styles).toContain(".brand-mark__glyph");
    expect(styles).not.toContain(".brand-mark__image");
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
