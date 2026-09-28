import en from "../messages/en.json";
import zhCN from "../messages/zh-CN.json";
import zhTW from "../messages/zh-TW.json";

// Localized *display* copy for the pricing cards. This is the commercial-license
// side of the pricing split: the canonical English + structural data stays in
// `./catalog` (PlanConfig, used by product creation and analytics); this is only
// what the marketing UI shows. The web app merges it under the `pricing`
// namespace of its i18n catalog (design D8 / §20).
export const billingMessages = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
} as const;

export type BillingMessageLocale = keyof typeof billingMessages;

export function getBillingMessages(locale: string) {
  return billingMessages[locale as BillingMessageLocale] ?? billingMessages.en;
}

/** The interactive controls also accept incomplete translation catalogs. */
export function getBillingControls(locale: string) {
  const controls = { ...en.controls };
  const translated = getBillingMessages(locale).controls;
  for (const key of Object.keys(controls) as Array<keyof typeof controls>) {
    const value = translated?.[key];
    if (typeof value === "string" && value.trim()) controls[key] = value;
  }
  return controls;
}

/**
 * The six UI-facing copy namespaces localized for PR F (billing, usage,
 * activity, checkout, sidebar, common). Kept separate from `plans` and
 * `controls`, whose shape and accessors predate this catalogue and stay
 * unchanged.
 */
export type BillingCopy = Pick<
  typeof en,
  "billing" | "usage" | "activity" | "checkout" | "sidebar" | "common"
>;

const COPY_NAMESPACES = [
  "billing",
  "usage",
  "activity",
  "checkout",
  "sidebar",
  "common",
] as const satisfies ReadonlyArray<keyof BillingCopy>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively falls back to the English value for every leaf: a missing,
 * empty or non-string translation at any depth is replaced by its English
 * counterpart, exactly like `getBillingControls` does for the flat
 * `controls` object.
 */
function fallbackToEnglish<T>(englishValue: T, translatedValue: unknown): T {
  if (typeof englishValue === "string") {
    return (
      typeof translatedValue === "string" && translatedValue.trim()
        ? translatedValue
        : englishValue
    ) as T;
  }

  if (Array.isArray(englishValue)) {
    return (
      Array.isArray(translatedValue) &&
      translatedValue.length === englishValue.length
        ? englishValue.map((item, index) =>
            fallbackToEnglish(item, translatedValue[index]),
          )
        : englishValue
    ) as T;
  }

  if (isPlainObject(englishValue)) {
    const translatedObject = isPlainObject(translatedValue)
      ? translatedValue
      : {};
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(englishValue)) {
      result[key] = fallbackToEnglish(
        (englishValue as Record<string, unknown>)[key],
        translatedObject[key],
      );
    }
    return result as T;
  }

  return englishValue;
}

/** The UI copy namespaces also accept incomplete translation catalogs. */
export function getBillingCopy(locale: string): BillingCopy {
  const translated = getBillingMessages(locale);
  return Object.fromEntries(
    COPY_NAMESPACES.map((namespace) => [
      namespace,
      fallbackToEnglish(en[namespace], translated[namespace]),
    ]),
  ) as BillingCopy;
}

/**
 * Replaces every `{name}` placeholder in `template` with the matching entry
 * from `values`. A placeholder with no supplied value is left in the output
 * verbatim (visible), rather than silently dropped, so a missing value is
 * easy to spot instead of producing misleading copy.
 */
export function formatCopy(
  template: string,
  values: Record<string, string | number> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : match,
  );
}
