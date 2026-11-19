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
