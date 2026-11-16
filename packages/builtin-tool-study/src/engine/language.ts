import {
  LANGUAGE_MAJORITY_SHARE,
  MIN_HAN_SHARE,
  MIN_LATIN_SHARE,
} from "./constants";

/**
 * Output language: an explicit request wins; otherwise the language holding at
 * least 60% of the corpus tokens; a mixed or untagged corpus follows the UI.
 */
export function resolveOutputLanguage(input: {
  requested?: string | null;
  chunks: readonly { language: string | null; tokens: number }[];
  uiLocale: string;
}): string {
  const requested = input.requested?.trim();
  if (requested) return requested;

  const tokensByLanguage = new Map<string, number>();
  let total = 0;
  for (const chunk of input.chunks) {
    total += chunk.tokens;
    if (!chunk.language) continue;
    tokensByLanguage.set(
      chunk.language,
      (tokensByLanguage.get(chunk.language) ?? 0) + chunk.tokens,
    );
  }
  let best: [string, number] | null = null;
  for (const entry of tokensByLanguage) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  if (best && total > 0 && best[1] / total >= LANGUAGE_MAJORITY_SHARE) {
    return best[0];
  }
  return input.uiLocale;
}

const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

/**
 * A cheap script check of generated text: Chinese output must be at least 30%
 * Han letters, English output at least 60% Latin letters. Other languages, and
 * text without letters, are not judged.
 */
export function matchesOutputLanguage(text: string, language: string): boolean {
  const primary = language.toLowerCase().split(/[-_]/)[0];
  if (primary !== "zh" && primary !== "en") return true;
  let letters = 0;
  let han = 0;
  let latin = 0;
  for (const char of text) {
    if (!LETTER.test(char)) continue;
    letters += 1;
    if (HAN.test(char)) han += 1;
    else if (LATIN.test(char)) latin += 1;
  }
  if (letters === 0) return true;
  return primary === "zh"
    ? han / letters >= MIN_HAN_SHARE
    : latin / letters >= MIN_LATIN_SHARE;
}
