import { deepMergeMessages } from "@sourceweft/i18n/catalog";
import { LOCALE_IDS } from "@sourceweft/i18n/locales";
// Import the subpath, not the barrel: the barrel transitively pulls
// market-contracts (a build-step package), which is irrelevant to this check.
import { userLanguageSchema } from "@sourceweft/contracts/user-settings";
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import zhCN from "../../messages/zh-CN.json";
import zhTW from "../../messages/zh-TW.json";
import billingEn from "../../../../enterprise/billing/messages/en.json";
import billingZhCN from "../../../../enterprise/billing/messages/zh-CN.json";
import billingZhTW from "../../../../enterprise/billing/messages/zh-TW.json";

type Json = string | string[] | { [key: string]: Json };

const CATALOGS: Record<string, Json> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

// The pricing display copy lives in the licensed billing package but merges into
// the web `pricing` namespace, so it must stay aligned the same way.
const BILLING_CATALOGS: Record<string, Json> = {
  en: billingEn,
  "zh-CN": billingZhCN,
  "zh-TW": billingZhTW,
};

/** Flatten to `dotted.key -> leaf`, where a leaf is a string or a string[]. */
function leaves(value: Json, prefix = ""): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  if (typeof value === "string" || Array.isArray(value)) {
    out.set(prefix, value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    for (const [k, v] of leaves(child, path)) {
      out.set(k, v);
    }
  }
  return out;
}

/**
 * Top-level ICU argument names like `{year}` or `{count, plural, …}`. An
 * argument is a `{name}` or `{name,`; words inside plural/select sub-messages
 * (e.g. the `No` in `{No essays}`) are followed by a space, so the `[,}]` guard
 * excludes them.
 */
function placeholders(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1] as string),
  );
}

describe("message catalog alignment", () => {
  it("covers every first-phase locale", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...LOCALE_IDS].sort());
  });

  const enLeaves = leaves(en);

  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    describe(locale, () => {
      const localeLeaves = leaves(deepMergeMessages(en, catalog as object));

      it("has all English keys after applying the fallback", () => {
        expect([...localeLeaves.keys()].sort()).toEqual(
          [...enLeaves.keys()].sort(),
        );
      });

      it("has no empty strings and array arity matches English", () => {
        for (const [key, value] of localeLeaves) {
          const enValue = enLeaves.get(key);
          if (Array.isArray(value)) {
            expect(Array.isArray(enValue), key).toBe(true);
            expect(value.length, key).toBe((enValue as string[]).length);
            for (const item of value) {
              expect(item.trim().length, key).toBeGreaterThan(0);
            }
          } else {
            expect(value.trim().length, key).toBeGreaterThan(0);
          }
        }
      });

      it("uses the same ICU placeholders as English", () => {
        for (const [key, value] of localeLeaves) {
          if (
            typeof value === "string" &&
            typeof enLeaves.get(key) === "string"
          ) {
            expect([...placeholders(value)].sort(), key).toEqual(
              [...placeholders(enLeaves.get(key) as string)].sort(),
            );
          }
        }
      });
    });
  }
});

describe("billing pricing catalog alignment", () => {
  const enLeaves = leaves(BILLING_CATALOGS.en as Json);
  for (const [locale, catalog] of Object.entries(BILLING_CATALOGS)) {
    it(`${locale} has the same effective keys and array arity as English`, () => {
      const localeLeaves = leaves(
        deepMergeMessages(billingEn, catalog as object),
      );
      expect([...localeLeaves.keys()].sort()).toEqual(
        [...enLeaves.keys()].sort(),
      );
      for (const [key, value] of localeLeaves) {
        const enValue = enLeaves.get(key);
        if (Array.isArray(value)) {
          expect((enValue as string[]).length, key).toBe(value.length);
        }
      }
    });
  }
});

describe("settings-alignment.test.ts", () => {
  // The `language` user setting is a literal enum in the contracts package (which
  // must stay dependency-light), so this test is the guard that keeps it aligned
  // with the i18n package's source of truth. Adding a locale in one place without
  // the other fails here.
  describe("user language setting alignment", () => {
    it("offers exactly the supported locales plus 'system'", () => {
      const options = [...userLanguageSchema.options].sort();
      const expected = ["system", ...LOCALE_IDS].sort();
      expect(options).toEqual(expected);
    });
  });
});
