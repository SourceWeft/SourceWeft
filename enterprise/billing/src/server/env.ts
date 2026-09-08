/**
 * Lenient boolean parsing for deployment flags.
 *
 * Operators write flags by hand, in shells, Compose files and dashboards, and
 * they do not all write `true`. This accepts the spellings people actually use
 * — `true/1/yes/on` and `false/0/no/off/disabled` — case-insensitively and with
 * surrounding whitespace trimmed. Anything it does not recognise (including an
 * empty string) falls back to the caller's default rather than guessing, so a
 * typo cannot flip a flag to a value nobody intended.
 *
 * This deliberately does NOT throw. It is for optional feature flags where a
 * sane default is the right answer.
 *
 * NOT for Provider activation. `activation.env` variables are governed by
 * AGENTS.md and must accept only `true`, `false`, `1`, `0`, failing
 * configuration loading on anything else; they use `parseStrictBooleanEnv`
 * (`shared/config.ts`, `shared/model-gateway/global-config.ts`). Do not route
 * an activation variable through here — silently defaulting an invalid
 * activation value is exactly what that rule forbids.
 */

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off", "disabled"]);

/** Parse a raw environment value into a boolean, or return `fallback`. */
export function parseBooleanEnv(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  return fallback;
}

/** {@link parseBooleanEnv} against `process.env`, by variable name. */
export function readBooleanEnv(name: string, fallback: boolean): boolean {
  return parseBooleanEnv(process.env[name], fallback);
}
