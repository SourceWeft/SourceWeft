/** Share of letters that must be Han for Chinese output... */
const MIN_HAN_SHARE = 0.3;
/** ...and Latin for English output. */
const MIN_LATIN_SHARE = 0.6;

const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

/**
 * A cheap script check of generated text: Chinese output must be at least 30%
 * Han letters, English output at least 60% Latin letters. Other languages, and
 * text without letters, are not judged.
 *
 * `latinWordUnits` (Chinese output only): a run of Latin letters counts as one
 * unit, as one Han letter does. Short answers that keep English names, codes or
 * quotations as instructed would otherwise read as English, since every letter
 * of a kept name weighs as much as a Han character.
 */
export function matchesOutputLanguage(
  text: string,
  language: string,
  options: { latinWordUnits?: boolean } = {},
): boolean {
  const primary = language.toLowerCase().split(/[-_]/)[0];
  if (primary !== "zh" && primary !== "en") return true;
  const wordUnits = primary === "zh" && options.latinWordUnits === true;
  let letters = 0;
  let han = 0;
  let latin = 0;
  let inLatinWord = false;
  for (const char of text) {
    const isLatin = LETTER.test(char) && LATIN.test(char);
    const continuesWord = wordUnits && isLatin && inLatinWord;
    inLatinWord = isLatin;
    if (!LETTER.test(char) || continuesWord) continue;
    letters += 1;
    if (HAN.test(char)) han += 1;
    else if (isLatin) latin += 1;
  }
  if (letters === 0) return true;
  return primary === "zh"
    ? han / letters >= MIN_HAN_SHARE
    : latin / letters >= MIN_LATIN_SHARE;
}

/**
 * Share of the corpus a language must hold for the output to follow it
 * rather than the UI locale.
 */
export const LANGUAGE_MAJORITY_SHARE = 0.6;

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
