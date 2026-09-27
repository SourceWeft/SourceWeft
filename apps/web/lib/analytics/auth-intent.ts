// Web sign-in spans redirects (OAuth), new tabs (magic links) and plain form
// posts. Instead of instrumenting each path's success, the auth page records
// which method the person started with, and `AuthAnalyticsTracker` reports it
// once a session appears.

export const AUTH_INTENT_KEY = "sw_auth_intent";
export const AUTH_INTENT_TTL_MS = 30 * 60 * 1000;

// The desktop app reports its own login when the browser hands back.
const DESKTOP_COMPLETE_PREFIX = "/auth/desktop-complete";

type StoredIntent = { method: string; at: number };

export function recordAuthIntent(
  method: string,
  redirectTo?: string | null,
  now = Date.now(),
): void {
  if (redirectTo?.startsWith(DESKTOP_COMPLETE_PREFIX)) {
    return;
  }
  try {
    const intent: StoredIntent = { method, at: now };
    localStorage.setItem(AUTH_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // Storage blocked (private mode, disabled site data): skip tracking.
  }
}

export function consumeAuthIntent(now = Date.now()): { method: string } | null {
  try {
    const raw = localStorage.getItem(AUTH_INTENT_KEY);
    if (raw === null) {
      return null;
    }
    localStorage.removeItem(AUTH_INTENT_KEY);
    const intent = JSON.parse(raw) as Partial<StoredIntent>;
    if (
      typeof intent.method !== "string" ||
      typeof intent.at !== "number" ||
      now - intent.at > AUTH_INTENT_TTL_MS
    ) {
      return null;
    }
    return { method: intent.method };
  } catch {
    return null;
  }
}

/** An account created within the intent window is a new sign-up. */
export function classifyAuthEvent(
  createdAt: Date | string | undefined,
  now = Date.now(),
): "sign_up" | "login" {
  if (createdAt === undefined) {
    return "login";
  }
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) && now - created <= AUTH_INTENT_TTL_MS
    ? "sign_up"
    : "login";
}
