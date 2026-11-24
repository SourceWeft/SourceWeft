/**
 * Chunk language labels, as the tags the app offers for output: "zh-CN",
 * "zh-TW", "ja", "ko", else an ISO 639-1 code ("en", "es", "ru", …).
 *
 * Chinese, Japanese and Korean are told apart by script, and simplified from
 * traditional Chinese by characters only one of them uses. Other text goes to
 * a trigram detector (eld), loaded on first need. Code, links and markup are
 * removed first; a chunk with too few letters to judge takes the language
 * most of its document is in, or none.
 */

/** Frequent characters used only in simplified Chinese... */
export const SIMPLIFIED_ONLY =
  "们这国说为个来时会过对还样发学经现动问进头长开关见气业东车门书无与万应两让间实点听认读语话边产员亲热马鸟鱼钱买卖观总图种数据题机电权条务规区级华将从网证设计处当体义并";
/** ...and their traditional forms, in the same order. */
export const TRADITIONAL_ONLY =
  "們這國說為個來時會過對還樣發學經現動問進頭長開關見氣業東車門書無與萬應兩讓間實點聽認讀語話邊產員親熱馬鳥魚錢買賣觀總圖種數據題機電權條務規區級華將從網證設計處當體義並";

/** CJK characters a chunk needs before its script decides its language. */
const MIN_CJK_CHARS = 10;
/** Letters other text needs before the detector is asked. */
const MIN_DETECTOR_LETTERS = 50;
/** Share of the kanji and kana that must be kana for Japanese. */
const MIN_KANA_SHARE = 0.2;
/** Share of a document's labelled text one language must hold to be its language. */
const DOCUMENT_MAJORITY_SHARE = 0.6;

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LETTER = /\p{L}/u;
const SCRIPT_LANGUAGES = new Set(["zh", "ja", "ko"]);

const NOISE: readonly RegExp[] = [
  /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*|$)/gm,
  /`[^`\n]*`/g,
  /\]\([^)\s]*(?:\s+"[^"]*")?\)/g,
  /\b(?:https?|ftp):\/\/\S+/gi,
  /\bwww\.\S+/gi,
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  /<\/?[a-z][^>]*>/gi,
  /&[a-z]+;|&#\d+;/gi,
];

function stripNoise(text: string): string {
  return NOISE.reduce((rest, pattern) => rest.replace(pattern, " "), text);
}

type ScriptVerdict =
  | { kind: "language"; language: string }
  | { kind: "detector"; text: string }
  | { kind: "unknown" };

function judgeScript(text: string): ScriptVerdict {
  const clean = stripNoise(text);
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let otherLetters = 0;
  let otherWords = 0;
  let simplified = 0;
  let traditional = 0;
  let inWord = false;
  for (const char of clean) {
    if (!LETTER.test(char)) {
      inWord = false;
      continue;
    }
    if (HAN.test(char)) {
      han += 1;
      if (SIMPLIFIED_ONLY.includes(char)) simplified += 1;
      else if (TRADITIONAL_ONLY.includes(char)) traditional += 1;
    } else if (KANA.test(char)) kana += 1;
    else if (HANGUL.test(char)) hangul += 1;
    else {
      otherLetters += 1;
      if (!inWord) otherWords += 1;
      inWord = true;
      continue;
    }
    inWord = false;
  }

  // A CJK character weighs as much as a whole word of another script, so
  // English names and terms kept in Chinese text do not outvote it.
  const cjk = han + kana + hangul;
  if (cjk > 0 && cjk >= otherWords) {
    if (cjk < MIN_CJK_CHARS) return { kind: "unknown" };
    if (hangul > han + kana) return { kind: "language", language: "ko" };
    if (kana / (han + kana) >= MIN_KANA_SHARE) {
      return { kind: "language", language: "ja" };
    }
    if (simplified > traditional) return { kind: "language", language: "zh-CN" };
    if (traditional > simplified) return { kind: "language", language: "zh-TW" };
    return { kind: "unknown" };
  }
  return otherLetters >= MIN_DETECTOR_LETTERS
    ? { kind: "detector", text: clean }
    : { kind: "unknown" };
}

type Detector = { detect: (text: string) => { language: string; isReliable: () => boolean } };

let detectorPromise: Promise<Detector> | null = null;

function loadDetector(): Promise<Detector> {
  detectorPromise ??= import("eld/extrasmall").then((module) => module.eld);
  return detectorPromise;
}

/**
 * The language of each text, by script or detector; a text too short or
 * mixed to judge takes its document's language when one holds most of it.
 */
export async function labelChunkLanguages(
  texts: readonly string[],
): Promise<(string | null)[]> {
  const verdicts = texts.map(judgeScript);
  const detector = verdicts.some((verdict) => verdict.kind === "detector")
    ? await loadDetector()
    : null;
  const labels = verdicts.map((verdict) => {
    if (verdict.kind === "language") return verdict.language;
    if (verdict.kind !== "detector" || !detector) return null;
    const result = detector.detect(verdict.text);
    return result.language &&
      result.isReliable() &&
      !SCRIPT_LANGUAGES.has(result.language)
      ? result.language
      : null;
  });
  const majority = documentLanguage(
    texts.map((text, index) => ({ text, language: labels[index] ?? null })),
  );
  return labels.map((label) => label ?? majority);
}

/**
 * Text weight as the output-language resolver counts it: a CJK character is a
 * token, four other characters are one.
 */
function tokenWeight(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (HAN.test(char) || KANA.test(char) || HANGUL.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + other / 4;
}

/** The language at least 60% of the labelled text's tokens are in, else null. */
export function documentLanguage(
  chunks: readonly { text: string; language?: string | null }[],
): string | null {
  const weightByLanguage = new Map<string, number>();
  let total = 0;
  for (const chunk of chunks) {
    if (!chunk.language) continue;
    const weight = tokenWeight(chunk.text);
    total += weight;
    weightByLanguage.set(
      chunk.language,
      (weightByLanguage.get(chunk.language) ?? 0) + weight,
    );
  }
  for (const [language, weight] of weightByLanguage) {
    if (total > 0 && weight / total >= DOCUMENT_MAJORITY_SHARE) return language;
  }
  return null;
}
