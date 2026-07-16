import { describe, expect, it, vi } from "vitest";
import {
  UNAVAILABLE_MODELS_DISCLOSURE_KEY,
  parseUnavailableModelsDisclosurePreference,
  readUnavailableModelsDisclosurePreference,
  unavailableModelsDisclosureIsOpen,
  writeUnavailableModelsDisclosurePreference
} from "../src/lib/models-disclosure-preference.js";

describe("unavailable models disclosure preference", () => {
  it.each([
    [null, false],
    ["", false],
    ["closed", false],
    ["true", false],
    ["open", true]
  ] as const)("parses %s as %s", (value, expected) => {
    expect(parseUnavailableModelsDisclosurePreference(value)).toBe(expected);
  });

  it("defaults closed and survives unavailable session storage", () => {
    expect(readUnavailableModelsDisclosurePreference({ getItem: () => null })).toBe(false);
    expect(readUnavailableModelsDisclosurePreference({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
    expect(() => writeUnavailableModelsDisclosurePreference({ setItem: () => { throw new Error("blocked"); } }, true)).not.toThrow();
  });

  it("uses a versioned session preference for successful reads and writes", () => {
    const setItem = vi.fn();
    expect(readUnavailableModelsDisclosurePreference({
      getItem: (key) => key === UNAVAILABLE_MODELS_DISCLOSURE_KEY ? "open" : null
    })).toBe(true);

    writeUnavailableModelsDisclosurePreference({ setItem }, false);
    expect(setItem).toHaveBeenCalledWith(UNAVAILABLE_MODELS_DISCLOSURE_KEY, "closed");
  });

  it("forces the group open during search without changing the stored preference", () => {
    expect(unavailableModelsDisclosureIsOpen(false, "qwen")).toBe(true);
    expect(unavailableModelsDisclosureIsOpen(false, "   ")).toBe(false);
    expect(unavailableModelsDisclosureIsOpen(true, "")).toBe(true);
  });
});
