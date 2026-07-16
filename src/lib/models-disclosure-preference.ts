export const UNAVAILABLE_MODELS_DISCLOSURE_KEY = "dsbox:models:unavailable-open:v1";

export function parseUnavailableModelsDisclosurePreference(value: string | null): boolean {
  return value === "open";
}

export function readUnavailableModelsDisclosurePreference(storage: Pick<Storage, "getItem">): boolean {
  try {
    return parseUnavailableModelsDisclosurePreference(storage.getItem(UNAVAILABLE_MODELS_DISCLOSURE_KEY));
  } catch {
    return false;
  }
}

export function writeUnavailableModelsDisclosurePreference(
  storage: Pick<Storage, "setItem">,
  open: boolean
): void {
  try {
    storage.setItem(UNAVAILABLE_MODELS_DISCLOSURE_KEY, open ? "open" : "closed");
  } catch {
    // The disclosure remains usable when session storage is unavailable.
  }
}

export function unavailableModelsDisclosureIsOpen(preferredOpen: boolean, query: string): boolean {
  return preferredOpen || query.trim().length > 0;
}
