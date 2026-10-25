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
 * Server-supplied text as one safe line: control characters (including ESC and
 * the C1 range), line and paragraph separators and bidirectional overrides
 * are replaced, and the length is capped.
 */
export function printable(
  value: string | null | undefined,
  max: number = MAX_PRINTABLE_CHARS,
): string {
  if (!value) return "";
  const flat = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
