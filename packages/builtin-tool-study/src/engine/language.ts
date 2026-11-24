/**
 * Output language: an explicit request wins; otherwise the language holding at
 * least 60% of the corpus tokens; a mixed or untagged corpus follows the UI.
 * Shared with every grounded artifact type.
 */
export { resolveOutputLanguage } from "@sourceweft/grounded-generation";
