import { LANGUAGE_MAJORITY_SHARE } from "./constants";

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
