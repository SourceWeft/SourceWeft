import { expect, test } from "vitest";

import {
  aiDataConsentKey,
  hasAiDataConsent,
  recordAiDataConsent,
} from "./ai-data-consent";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("nothing is recorded until the person agrees, and then only for that account", () => {
  const storage = memoryStorage();
  expect(hasAiDataConsent("user-1", storage)).toBe(false);

  expect(
    recordAiDataConsent("user-1", storage, new Date("2026-11-14T08:00:00Z")),
  ).toBe(true);

  expect(hasAiDataConsent("user-1", storage)).toBe(true);
  expect(hasAiDataConsent("user-2", storage)).toBe(false);
  expect(storage.values.get(aiDataConsentKey("user-1"))).toBe(
    "2026-11-14T08:00:00.000Z",
  );
});

test("storage that cannot be used counts as no agreement, and says it stored nothing", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  expect(hasAiDataConsent("user-1", broken)).toBe(false);
  expect(recordAiDataConsent("user-1", broken)).toBe(false);
});
