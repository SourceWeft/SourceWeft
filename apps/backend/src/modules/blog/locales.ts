export const BLOG_LOCALES = [
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

export type BlogLocale = (typeof BLOG_LOCALES)[number];

const blogLocaleSet = new Set<string>(BLOG_LOCALES);

export function isBlogLocale(value: string): value is BlogLocale {
  return blogLocaleSet.has(value);
}

export function normalizeBlogLocale(value: string) {
  const trimmed = value.trim();
  const match = BLOG_LOCALES.find(
    (locale) => locale.toLowerCase() === trimmed.toLowerCase(),
  );

  return match ?? null;
}

