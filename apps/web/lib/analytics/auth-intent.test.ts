import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

import {
  AUTH_INTENT_KEY,
  AUTH_INTENT_TTL_MS,
  classifyAuthEvent,
  consumeAuthIntent,
  recordAuthIntent,
} from "./auth-intent";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 8, 27, 12);

test("intent round-trips once", () => {
  recordAuthIntent("google", "/dashboard", NOW);
  assert.deepEqual(consumeAuthIntent(NOW + 1000), { method: "google" });
  assert.equal(consumeAuthIntent(NOW + 2000), null);
});

test("expired intent is discarded", () => {
  recordAuthIntent("email", null, NOW);
  assert.equal(consumeAuthIntent(NOW + AUTH_INTENT_TTL_MS + 1), null);
  assert.equal(storage.store.has(AUTH_INTENT_KEY), false);
});

test("malformed intent is discarded", () => {
  storage.setItem(AUTH_INTENT_KEY, "{not json");
  assert.equal(consumeAuthIntent(NOW), null);
  assert.equal(storage.store.has(AUTH_INTENT_KEY), false);
});

test("desktop-complete redirects record nothing", () => {
  recordAuthIntent("email", "/auth/desktop-complete?code=1", NOW);
  assert.equal(storage.store.size, 0);
});

test("a desktop-complete sign-in clears a stale intent from an earlier attempt", () => {
  recordAuthIntent("email", "/dashboard", NOW);
  recordAuthIntent("email", "/auth/desktop-complete?code=1", NOW + 1000);
  assert.equal(consumeAuthIntent(NOW + 2000), null);
});

test("storage that throws is ignored", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  });
  recordAuthIntent("email", null, NOW);
  assert.equal(consumeAuthIntent(NOW), null);
});

test("classifies recent accounts as sign_up", () => {
  const fiveMinutesAgo = NOW - 5 * 60 * 1000;
  const thirtyOneMinutesAgo = NOW - 31 * 60 * 1000;
  assert.equal(classifyAuthEvent(new Date(fiveMinutesAgo).toISOString(), NOW), "sign_up");
  assert.equal(classifyAuthEvent(new Date(fiveMinutesAgo), NOW), "sign_up");
  assert.equal(classifyAuthEvent(new Date(thirtyOneMinutesAgo), NOW), "login");
  assert.equal(classifyAuthEvent(undefined, NOW), "login");
  assert.equal(classifyAuthEvent("not a date", NOW), "login");
});
