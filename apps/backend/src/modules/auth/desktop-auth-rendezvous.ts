const DEFAULT_TTL_MS = 10 * 60 * 1000;

type DesktopAuthEntry = {
  createdAt: number;
  expiresAt: number;
  token: string | null;
};

const entries = new Map<string, DesktopAuthEntry>();

function now() {
  return Date.now();
}

function isValidState(state: string) {
  return /^[a-zA-Z0-9._:-]{16,128}$/.test(state);
}

function cleanupExpired() {
  const timestamp = now();
  for (const [state, entry] of entries.entries()) {
    if (entry.expiresAt <= timestamp) {
      entries.delete(state);
    }
  }
}

export const desktopAuthRendezvous = {
  complete(input: { state: string; token: string }) {
    cleanupExpired();

    const state = input.state.trim();
    const token = input.token.trim();
    if (!isValidState(state) || !token) {
      return "invalid" as const;
    }

    const timestamp = now();
    const existing = entries.get(state);
    if (existing && existing.expiresAt <= timestamp) {
      entries.delete(state);
      return "expired" as const;
    }

    entries.set(state, {
      createdAt: existing?.createdAt ?? timestamp,
      expiresAt: timestamp + DEFAULT_TTL_MS,
      token,
    });
    return "ok" as const;
  },

  consume(stateInput: string) {
    cleanupExpired();

    const state = stateInput.trim();
    if (!isValidState(state)) {
      return { status: "invalid" as const };
    }

    const entry = entries.get(state);
    if (!entry) {
      return { status: "pending" as const };
    }

    if (entry.expiresAt <= now()) {
      entries.delete(state);
      return { status: "expired" as const };
    }

    if (!entry.token) {
      return { status: "pending" as const };
    }

    entries.delete(state);
    return { status: "complete" as const, token: entry.token };
  },
};
