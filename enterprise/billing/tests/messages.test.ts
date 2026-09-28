import { expect, test, vi } from "vitest";
import en from "../messages/en.json";
import zhCN from "../messages/zh-CN.json";
import zhTW from "../messages/zh-TW.json";
import {
  formatCopy,
  getBillingControls,
  getBillingCopy,
} from "../src/messages";

test("missing, empty and malformed billing controls fall back individually to English", async () => {
  vi.resetModules();
  vi.doMock("../messages/zh-CN.json", () => ({
    default: { controls: { monthly: "按月付费", yearly: "", opening: null } },
  }));

  const { getBillingControls: getBillingControlsMocked } =
    await import("../src/messages");

  expect(getBillingControlsMocked("zh-CN")).toEqual({
    ...getBillingControls("en"),
    monthly: "按月付费",
  });

  vi.doUnmock("../messages/zh-CN.json");
  vi.resetModules();
});

// ---- Catalogue structure: walk every locale file and extract {placeholder} ----
// tokens from every string leaf, keyed by its dotted path (array indices
// included), so drift between locales is caught at the exact key.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1] ?? "")
    .sort();
}

function walk(
  node: Json,
  prefix: string,
  out: Map<string, { value: string; placeholders: string[] }>,
): void {
  if (typeof node === "string") {
    out.set(prefix, { value: node, placeholders: placeholdersOf(node) });
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${prefix}[${index}]`, out));
    return;
  }

  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child === undefined) continue;
      walk(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

function catalogueLeaves(catalogue: Json) {
  const out = new Map<string, { value: string; placeholders: string[] }>();
  walk(catalogue, "", out);
  return out;
}

test("every en key exists in zh-CN and zh-TW with the same placeholders", () => {
  const enLeaves = catalogueLeaves(en);
  const zhCNLeaves = catalogueLeaves(zhCN);
  const zhTWLeaves = catalogueLeaves(zhTW);

  expect(enLeaves.size).toBeGreaterThan(0);

  for (const [path, { placeholders }] of enLeaves) {
    expect(zhCNLeaves.has(path), `zh-CN is missing key "${path}"`).toBe(true);
    expect(zhTWLeaves.has(path), `zh-TW is missing key "${path}"`).toBe(true);

    expect(
      zhCNLeaves.get(path)?.placeholders,
      `zh-CN["${path}"] placeholders differ from en`,
    ).toEqual(placeholders);
    expect(
      zhTWLeaves.get(path)?.placeholders,
      `zh-TW["${path}"] placeholders differ from en`,
    ).toEqual(placeholders);
  }

  // No locale should carry keys that en does not define.
  for (const path of zhCNLeaves.keys()) {
    expect(enLeaves.has(path), `zh-CN has an extra key "${path}"`).toBe(true);
  }
  for (const path of zhTWLeaves.keys()) {
    expect(enLeaves.has(path), `zh-TW has an extra key "${path}"`).toBe(true);
  }
});

/**
 * next-intl treats "." inside a message key as a nesting separator and
 * rejects any key that literally contains one, at any depth, with
 * `INVALID_KEY: Namespace keys cannot contain the character "."`. This
 * catalogue is merged into apps/web's next-intl `pricing` namespace (only
 * `plans` today, but next-intl's message validator walks whatever object it
 * is given, not just the namespace a particular `useTranslations()` call
 * reads), so a raw, dotted value — e.g. a ledger `feature` string like
 * `"ingestion.asr"` used as a lookup key — must be encoded (this catalogue
 * uses "." -> "__", see `activity.featureNames` / `formatActivityFeatureName`
 * in `billing-utils.ts`) before it becomes a JSON object key here.
 */
function collectDottedKeys(node: Json, path: string[] = []): string[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return [];
  }

  const found: string[] = [];
  for (const key of Object.keys(node)) {
    if (key.includes(".")) {
      found.push([...path, key].join(" > "));
    }
    found.push(...collectDottedKeys(node[key] as Json, [...path, key]));
  }
  return found;
}

test("no catalogue key at any depth contains a literal '.' in any locale", () => {
  for (const [locale, catalogue] of Object.entries({
    en,
    "zh-CN": zhCN,
    "zh-TW": zhTW,
  })) {
    expect(
      collectDottedKeys(catalogue as Json),
      `${locale} has one or more dotted keys`,
    ).toEqual([]);
  }
});

test("missing translations fall back to English", async () => {
  vi.resetModules();
  vi.doMock("../messages/zh-CN.json", () => ({
    default: {
      billing: { title: "账单" },
      usage: {},
      checkout: undefined,
    },
  }));

  const { getBillingCopy: getBillingCopyMocked } =
    await import("../src/messages");
  const englishCopy = getBillingCopy("en");
  const zhCopy = getBillingCopyMocked("zh-CN");

  // The one translated leaf survives...
  expect(zhCopy.billing.title).toBe("账单");
  // ...while every other leaf, at any depth, falls back to English.
  expect(zhCopy.billing.scopePersonal).toBe(englishCopy.billing.scopePersonal);
  expect(zhCopy.usage).toEqual(englishCopy.usage);
  expect(zhCopy.checkout).toEqual(englishCopy.checkout);
  expect(zhCopy.activity).toEqual(englishCopy.activity);
  expect(zhCopy.sidebar).toEqual(englishCopy.sidebar);
  expect(zhCopy.common).toEqual(englishCopy.common);

  vi.doUnmock("../messages/zh-CN.json");
  vi.resetModules();
});

test("getBillingCopy falls back to English for a locale the catalogue does not have", () => {
  expect(getBillingCopy("fr")).toEqual(getBillingCopy("en"));
});

test("getBillingCopy returns the real zh-CN translations when present", () => {
  const copy = getBillingCopy("zh-CN");
  expect(copy.billing.title).toBe(zhCN.billing.title);
  expect(copy.activity.consume.ingestion.page).toBe(
    zhCN.activity.consume.ingestion.page,
  );
});

test("formatCopy replaces placeholders and keeps unknown ones", () => {
  expect(
    formatCopy("{used} of {limit} seats used", { used: 3, limit: 10 }),
  ).toBe("3 of 10 seats used");
  // A placeholder with no supplied value stays visible, verbatim.
  expect(formatCopy("{used} of {limit} seats used", { used: 3 })).toBe(
    "3 of {limit} seats used",
  );
  // Values that aren't provided at all leave the whole template untouched.
  expect(formatCopy("No {unit} activity yet")).toBe("No {unit} activity yet");
  // A numeric value is stringified.
  expect(formatCopy("{count} seats remaining", { count: 0 })).toBe(
    "0 seats remaining",
  );
});
