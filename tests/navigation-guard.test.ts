import { describe, expect, it } from "vitest";
import { navigationNeedsSettingsConfirmation } from "../src/lib/navigation-guard.js";

describe("settings navigation guard", () => {
  it("only blocks leaving dirty Settings", () => {
    expect(navigationNeedsSettingsConfirmation("settings", "chat", true)).toBe(true);
    expect(navigationNeedsSettingsConfirmation("settings", "settings", true)).toBe(false);
    expect(navigationNeedsSettingsConfirmation("settings", "chat", false)).toBe(false);
    expect(navigationNeedsSettingsConfirmation("chat", "settings", true)).toBe(false);
  });
});
