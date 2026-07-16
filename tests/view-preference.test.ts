import { describe, expect, it, vi } from "vitest";
import {
  VIEW_PREFERENCE_KEY,
  parseViewPreference,
  readViewPreference,
  writeViewPreference
} from "../src/lib/view-preference.js";

describe("last view preference", () => {
  it.each(["chat", "models", "runtime", "agents", "monitor", "settings"] as const)("accepts %s", (view) => {
    expect(parseViewPreference(view)).toBe(view);
  });

  it.each([null, "", "activity", "unknown", "__proto__"])("falls back from %s", (value) => {
    expect(parseViewPreference(value)).toBe("chat");
  });

  it("survives unavailable storage", () => {
    expect(readViewPreference({ getItem: () => { throw new Error("blocked"); } })).toBe("chat");
    expect(() => writeViewPreference({ setItem: () => { throw new Error("blocked"); } }, "models")).not.toThrow();
  });

  it("uses a versioned key for successful reads and writes", () => {
    const setItem = vi.fn();
    expect(readViewPreference({ getItem: (key) => key === VIEW_PREFERENCE_KEY ? "agents" : null })).toBe("agents");
    writeViewPreference({ setItem }, "monitor");
    expect(setItem).toHaveBeenCalledWith(VIEW_PREFERENCE_KEY, "monitor");
  });
});
