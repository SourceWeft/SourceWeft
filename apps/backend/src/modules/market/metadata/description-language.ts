/**
 * The language a description was written in, from its script alone. Cheap and
 * deliberately coarse: no model, no dictionary. Latin script is reported as
 * English, the catalog's source language, though it may be Spanish or German;
 * the translation prompt therefore never assumes English (see
 * `summary-translation.ts`). A script that is neither Latin nor CJK is `und`
 * (undetermined) rather than a guess at a language.
 */

export type DescriptionLanguage = "en" | "zh" | "ja" | "ko" | "und";

// URLs, code spans and identifiers say nothing about the language around them.
const NOISE = /https?:\/\/\S+|`[^`]*`|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g;

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

/** Share of the letters a script needs to decide the language. */
const KANA_SHARE = 0.1;
const CJK_SHARE = 0.3;

export function detectDescriptionLanguage(
  description: string,
): DescriptionLanguage {
  let letters = 0;
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  for (const char of description.replace(NOISE, " ")) {
    if (!LETTER.test(char)) continue;
    letters += 1;
    if (HAN.test(char)) han += 1;
    else if (KANA.test(char)) kana += 1;
    else if (HANGUL.test(char)) hangul += 1;
    else if (LATIN.test(char)) latin += 1;
  }
  if (letters === 0) return "en";
  // Japanese mixes kana with Han; a little kana is enough to tell it from Chinese.
  if (kana / letters >= KANA_SHARE) return "ja";
  if (hangul / letters >= CJK_SHARE) return "ko";
  if (han / letters >= CJK_SHARE) return "zh";
  return latin / letters >= CJK_SHARE ? "en" : "und";
}
