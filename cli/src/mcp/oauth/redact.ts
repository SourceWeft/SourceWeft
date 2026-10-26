/**
 * Keeps credentials out of anything the CLI prints. Known secrets are removed
 * by value; what looks like one is removed by shape, because a server's error
 * text may repeat a token the CLI never held.
 */

const REDACTED = "[redacted]";
const MIN_SECRET_CHARS = 6;

const SHAPES: readonly RegExp[] = [
  /\bBearer\s+[\w\-.~+/]+=*/giu,
  /\b(access_token|refresh_token|id_token|client_secret|code_verifier|code)=[^&\s"']+/giu,
  /"(access_token|refresh_token|id_token|client_secret|code_verifier)"\s*:\s*"[^"]*"/giu,
];

export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= MIN_SECRET_CHARS) {
      result = result.split(secret).join(REDACTED);
    }
  }
  for (const shape of SHAPES) {
    result = result.replace(shape, (match) => {
      const separator = match.search(/[=:]/u);
      if (/^bearer/iu.test(match)) return `Bearer ${REDACTED}`;
      if (match.startsWith('"')) {
        const key = match.slice(0, match.indexOf('"', 1) + 1);
        return `${key}: "${REDACTED}"`;
      }
      return `${match.slice(0, separator + 1)}${REDACTED}`;
    });
  }
  return result;
}

const MAX_PRINTABLE_CHARS = 300;

/**
 * Characters that must not reach a terminal or a model from a server's text:
 * C0 and C1 controls (including ESC, which starts OSC and CSI sequences, and
 * BEL), line and paragraph separators, and every format character — bidi
 * overrides, zero-width characters, the byte order mark and the Unicode tag
 * block that can carry text no one sees — plus variation selectors.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/gu;

/**
 * Server-supplied text as one safe line: the characters above are replaced,
 * and the length is capped.
 */
export function printable(
  value: string | null | undefined,
  max: number = MAX_PRINTABLE_CHARS,
): string {
  if (!value) return "";
  const flat = value.replace(UNSAFE_TEXT, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Text that may span lines (an error message with its details) made safe for
 * a terminal: the same characters are replaced, line breaks are kept.
 */
export function terminalSafe(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(UNSAFE_TEXT, " "))
    .join("\n");
}
