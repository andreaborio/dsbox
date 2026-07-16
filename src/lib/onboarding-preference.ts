export type OnboardingPreference = "completed" | "dismissed" | null;

export const ONBOARDING_PREFERENCE_KEY = "dsbox:onboarding-state:v2";

export function parseOnboardingPreference(value: string | null): OnboardingPreference {
  return value === "completed" || value === "dismissed" ? value : null;
}

export function readOnboardingPreference(storage: Pick<Storage, "getItem">): OnboardingPreference {
  try {
    return parseOnboardingPreference(storage.getItem(ONBOARDING_PREFERENCE_KEY));
  } catch {
    return null;
  }
}

export function writeOnboardingPreference(
  storage: Pick<Storage, "setItem">,
  preference: Exclude<OnboardingPreference, null>
): void {
  try {
    storage.setItem(ONBOARDING_PREFERENCE_KEY, preference);
  } catch {
    // A storage failure must not block the first-run flow.
  }
}

export function shouldShowOnboarding({
  modelPresent,
  preference,
  hiddenForSession
}: {
  modelPresent: boolean;
  preference: OnboardingPreference;
  hiddenForSession: boolean;
}): boolean {
  return !modelPresent && preference === null && !hiddenForSession;
}
