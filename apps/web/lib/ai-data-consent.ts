/**
 * The record that a person agreed, in this app on this device, to their chat
 * content being sent to third-party AI model providers.
 *
 * The App Store requires an app to say where personal data is shared with
 * third parties, third-party AI included, and to get explicit permission
 * first. The iOS app asks once per account and device and keeps the answer
 * here. It is kept on the device only: reinstalling the app, or signing in on
 * another device, asks again.
 */
const KEY_PREFIX = "sourceweft.ai-data-consent.v1:";

type ConsentStorage = Pick<Storage, "getItem" | "setItem">;

function resolveStorage(storage?: ConsentStorage): ConsentStorage | null {
  if (storage) {
    return storage;
  }
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function aiDataConsentKey(userId: string) {
  return `${KEY_PREFIX}${userId}`;
}

/** False when nothing is recorded or the device's storage cannot be read. */
export function hasAiDataConsent(userId: string, storage?: ConsentStorage) {
  try {
    return Boolean(resolveStorage(storage)?.getItem(aiDataConsentKey(userId)));
  } catch {
    return false;
  }
}

/**
 * Records the agreement. Returns false when it could not be stored; the
 * agreement then holds for this visit only and is asked again next time.
 */
export function recordAiDataConsent(
  userId: string,
  storage?: ConsentStorage,
  now: Date = new Date(),
) {
  try {
    const target = resolveStorage(storage);
    if (!target) {
      return false;
    }
    target.setItem(aiDataConsentKey(userId), now.toISOString());
    return true;
  } catch {
    return false;
  }
}
