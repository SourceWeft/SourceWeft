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
