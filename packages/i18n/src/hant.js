// Simplified → Traditional Chinese (Taiwan) for everything SourceWeft renders in
// zh-TW: the web UI catalogs (apps/web/scripts/i18n-hant.mjs) and generated
// content such as skill overviews (backend). OpenCC `twp` handles characters and
// common phrasing; the glossary then applies product terms and the fixes OpenCC
// gets wrong. One glossary keeps UI and content in the same vocabulary.
//
// Plain JS (with hant.d.ts) so the web generator can run it under bare Node.
import { Converter } from "opencc-js/cn2t";

import glossary from "../glossary/zh-TW.json" with { type: "json" };

/** Glossary entries, longest source first so a phrase wins over its substrings. */
const glossaryEntries = Object.entries(glossary).sort(
  (a, b) => b[0].length - a[0].length,
);

let converter = null;

/** Simplified Chinese text in Traditional Chinese, Taiwan usage and SourceWeft terms. */
export function toTaiwanTraditional(text) {
  converter ??= Converter({ from: "cn", to: "twp" });
  let out = converter(text);
  for (const [from, to] of glossaryEntries) {
    out = out.split(from).join(to);
  }
  return out;
}

/** The glossary applied after OpenCC: converted text → preferred Taiwan wording. */
export const zhTwGlossary = Object.freeze({ ...glossary });
