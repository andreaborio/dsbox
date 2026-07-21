import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatSessionStore, type ChatStorage } from "../src/lib/chat-session.js";
import { readOnboardingPreference } from "../src/lib/onboarding-preference.js";
import { readUnavailableModelsDisclosurePreference } from "../src/lib/models-disclosure-preference.js";
import { readThemePreference } from "../src/theme/runtime.js";
import { readViewPreference } from "../src/lib/view-preference.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "legacy-v0.3.2-state.json");

class FrozenStorage implements ChatStorage {
  constructor(private readonly values: Map<string, string>) {}
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("Hebrus Studio upgrade compatibility", () => {
  it("opens the frozen v0.3.2 browser state without rewriting its keys", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const values = new Map<string, string>(Object.entries(fixture.browserStorage));
    const storage = new FrozenStorage(values);

    expect(readThemePreference(storage)).toBe("dsbox-dark");
    expect(readOnboardingPreference(storage)).toBe("completed");
    expect(readViewPreference(storage)).toBe("models");
    expect(readUnavailableModelsDisclosurePreference(storage)).toBe(true);

    const chats = new ChatSessionStore({ storage, createId: () => "unused" });
    expect(chats.getSnapshot()).toMatchObject({
      activeThreadId: "legacy-thread",
      webSearchEnabled: false,
      messages: [{ id: "legacy-message", content: "Keep this conversation" }]
    });
    expect([...values.keys()].every((key) => key.startsWith("dsbox:"))).toBe(true);
  });

  it("keeps server state filenames and both runtime lifecycle states frozen", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(fixture.stateFiles).toEqual({
      config: "config.json",
      inventory: "local-models.json",
      downloads: "downloads/state.json"
    });
    expect(fixture.runtimeStates).toEqual(["stopped", "running"]);
  });
});
