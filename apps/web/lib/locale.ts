export const LOCALE_COOKIE_NAME = "sw_locale";

export const SUPPORTED_LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "ar",
  "he",
  "hi",
  "th",
] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export type LocaleDirection = "ltr" | "rtl";

export const DEFAULT_LOCALE: AppLocale = "en";

const BASE_LANGUAGE_MAP: Record<string, AppLocale> = {
  ar: "ar",
  en: "en",
  he: "he",
  hi: "hi",
  ja: "ja",
  ko: "ko",
  mr: "hi",
  ne: "hi",
  th: "th",
  zh: "zh-CN",
};

const DIRECTION_BY_LOCALE: Record<AppLocale, LocaleDirection> = {
  en: "ltr",
  "zh-CN": "ltr",
  "zh-TW": "ltr",
  ja: "ltr",
  ko: "ltr",
  ar: "rtl",
  he: "rtl",
  hi: "ltr",
  th: "ltr",
};

type LocaleResolutionInput = {
  headerLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
};

type WeightedLanguageTag = {
  tag: string;
  quality: number;
};

export function normalizeLocale(value?: string | null): AppLocale | null {
  if (!value) {
    return null;
  }

  const raw = value.trim().replace(/_/g, "-");
  if (!raw) {
    return null;
  }

  const lower = raw.toLowerCase();

  for (const locale of SUPPORTED_LOCALES) {
    if (locale.toLowerCase() === lower) {
      return locale;
    }
  }

  if (lower.startsWith("zh")) {
    if (
      lower.includes("-hant") ||
      lower.endsWith("-tw") ||
      lower.endsWith("-hk") ||
      lower.endsWith("-mo")
    ) {
      return "zh-TW";
    }

    return "zh-CN";
  }

  const [base = ""] = lower.split("-");
  return BASE_LANGUAGE_MAP[base] ?? null;
}

function parseAcceptLanguage(headerValue: string): WeightedLanguageTag[] {
  return headerValue
    .split(",")
    .map((entry) => {
      const [tagPart, ...parameterParts] = entry.split(";");
      const tag = tagPart?.trim().toLowerCase();

      if (!tag) {
        return null;
      }

      let quality = 1;

      for (const part of parameterParts) {
        const parameter = part.trim();
        if (!parameter.startsWith("q=")) {
          continue;
        }

        const parsed = Number.parseFloat(parameter.slice(2));
        if (!Number.isNaN(parsed)) {
          quality = Math.max(0, Math.min(1, parsed));
        }
      }

      return { tag, quality };
    })
    .filter((entry): entry is WeightedLanguageTag => entry !== null)
    .sort((a, b) => b.quality - a.quality);
}

export function resolveLocaleFromAcceptLanguage(
  acceptLanguage?: string | null,
): AppLocale | null {
  if (!acceptLanguage) {
    return null;
  }

  const weightedTags = parseAcceptLanguage(acceptLanguage);

  for (const { tag } of weightedTags) {
    if (tag === "*") {
      continue;
    }

    const locale = normalizeLocale(tag);
    if (locale) {
      return locale;
    }
  }

  return null;
}

export function resolveRequestLocale({
  headerLocale,
  cookieLocale,
  acceptLanguage,
}: LocaleResolutionInput): AppLocale {
  return (
    normalizeLocale(headerLocale) ??
    normalizeLocale(cookieLocale) ??
    resolveLocaleFromAcceptLanguage(acceptLanguage) ??
    DEFAULT_LOCALE
  );
}

export function getLocaleDirection(locale: AppLocale): LocaleDirection {
  return DIRECTION_BY_LOCALE[locale];
}
