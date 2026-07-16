import { describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_PREFERENCE_KEY,
  parseOnboardingPreference,
  readOnboardingPreference,
  shouldShowOnboarding,
  writeOnboardingPreference
} from "../src/lib/onboarding-preference.js";

describe("onboarding lifecycle", () => {
  it("only accepts explicit versioned completion states", () => {
    expect(parseOnboardingPreference("completed")).toBe("completed");
    expect(parseOnboardingPreference("dismissed")).toBe("dismissed");
    expect(parseOnboardingPreference("1")).toBeNull();
    expect(parseOnboardingPreference(null)).toBeNull();
  });

  it("does not treat choosing a source as persistent completion", () => {
    expect(shouldShowOnboarding({ modelPresent: false, preference: null, hiddenForSession: false })).toBe(true);
    expect(shouldShowOnboarding({ modelPresent: false, preference: null, hiddenForSession: true })).toBe(false);
    expect(shouldShowOnboarding({ modelPresent: false, preference: null, hiddenForSession: false })).toBe(true);
  });

  it("stays hidden after a real model or explicit dismissal", () => {
    expect(shouldShowOnboarding({ modelPresent: true, preference: null, hiddenForSession: false })).toBe(false);
    expect(shouldShowOnboarding({ modelPresent: false, preference: "completed", hiddenForSession: false })).toBe(false);
    expect(shouldShowOnboarding({ modelPresent: false, preference: "dismissed", hiddenForSession: false })).toBe(false);
  });

  it("uses the new key and tolerates blocked storage", () => {
    const setItem = vi.fn();
    expect(readOnboardingPreference({ getItem: (key) => key === ONBOARDING_PREFERENCE_KEY ? "completed" : "1" })).toBe("completed");
    expect(readOnboardingPreference({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
    writeOnboardingPreference({ setItem }, "dismissed");
    expect(setItem).toHaveBeenCalledWith(ONBOARDING_PREFERENCE_KEY, "dismissed");
    expect(() => writeOnboardingPreference({ setItem: () => { throw new Error("blocked"); } }, "completed")).not.toThrow();
  });
});
