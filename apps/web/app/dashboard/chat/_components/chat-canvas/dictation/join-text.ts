// Characters that end a sentence; a hard cut (the segmenter cutting mid-speech
// rather than at a pause) removes one trailing mark of this kind, since a
// pause-only marker printed by the recognizer there is almost always wrong.
const SENTENCE_FINAL_MARKS = new Set(["。", ".", "!", "?", "！", "？"]);

// Characters after which a Latin/digit continuation needs a separating space.
const SPACE_BEFORE_LATIN_TRIGGERS = new Set([".", ",", "!", "?", ";", ":"]);

function isLatinLetterOrDigit(char: string): boolean {
  return /^[A-Za-z0-9]$/.test(char);
}

/** The string to insert for `next`, given the last character dictation inserted before it ("" for the first). */
export function joinDictationText(
  previousTail: string,
  next: string,
  options: { hardCut: boolean },
): string {
  let text = next.trim();

  if (options.hardCut && text.length > 0) {
    const lastChar = text[text.length - 1]!;
    if (SENTENCE_FINAL_MARKS.has(lastChar)) {
      text = text.slice(0, -1);
    }
  }

  if (text.length === 0) {
    return "";
  }

  const needsSpace =
    (isLatinLetterOrDigit(previousTail) ||
      SPACE_BEFORE_LATIN_TRIGGERS.has(previousTail)) &&
    isLatinLetterOrDigit(text[0]!);

  return needsSpace ? ` ${text}` : text;
}
