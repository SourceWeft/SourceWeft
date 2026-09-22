import { formatDate } from "@sourceweft/i18n/format";
import { isLocale } from "@sourceweft/i18n/locales";

/** Accept the locale exposed by next-intl; never infer it from the browser. */
export function formatDisplayDate(
  value: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  },
) {
  if (!isLocale(locale))
    throw new RangeError(`Unsupported UI locale: ${locale}`);
  return formatDate(value, locale, options);
}
