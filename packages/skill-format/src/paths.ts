/**
 * Path and name rules for skill material that ends up on a filesystem. Pure:
 * no IO, no `node:path` — every rule is about the `/`-separated string, so it
 * gives the same answer on every host OS.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/u;
const DRIVE_LETTER = /^[a-zA-Z]:/u;
/** Device names Windows refuses (or misroutes) as a file name, with any extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * Whether one path segment can be created as-is on every supported OS. Rejects
 * `.`/`..`, a trailing dot or space (Windows silently strips them, so two
 * different names collapse to one), and reserved device names.
 */
export function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.endsWith(".") &&
    !segment.endsWith(" ") &&
    !WINDOWS_RESERVED.test(segment)
  );
}

/**
 * A file path inside a skill bundle: relative, `/`-separated, and made only of
 * safe segments. Anything else — an absolute path, a backslash, a `..`
 * segment, an empty segment (`a//b`), a drive letter, a control character —
 * could resolve outside the directory the bundle is written into.
 */
export function isSafeBundlePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    DRIVE_LETTER.test(path) ||
    CONTROL_CHARS.test(path)
  ) {
    return false;
  }
  return path.split("/").every(isSafePathSegment);
}

/**
 * Two bundle paths that would land on the same file of a case-insensitive
 * filesystem (macOS and Windows default). Returns the offending pairs so the
 * caller can refuse the bundle instead of letting one file silently replace
 * the other on write.
 */
export function findCaseCollisions(
  paths: readonly string[],
): Array<[string, string]> {
  const seen = new Map<string, string>();
  const collisions: Array<[string, string]> = [];
  for (const path of paths) {
    const key = path.normalize("NFC").toLowerCase();
    const first = seen.get(key);
    if (first !== undefined && first !== path) {
      collisions.push([first, path]);
    } else {
      seen.set(key, path);
    }
  }
  return collisions;
}

const SKILL_DIR_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * A skill's name as a directory name: lowercase alphanumerics and hyphens,
 * 1–64 chars, never leading with a hyphen (a leading `-` reads as a flag to
 * any tool that later receives the directory as an argument).
 */
export function isSafeSkillDirName(name: string): boolean {
  return SKILL_DIR_NAME.test(name) && isSafePathSegment(name);
}

const AGENT_SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/**
 * A SKILL.md `name` as the Agent Skills specification (agentskills.io) defines
 * it: 1–64 lowercase letters, digits and hyphens, neither starting nor ending
 * with a hyphen, never two in a row. What the registry accepts at import, so
 * every indexed name is also a safe directory name (`isSafeSkillDirName`,
 * which is the looser rule a CLI install checks).
 */
export function isAgentSkillName(name: string): boolean {
  return AGENT_SKILL_NAME.test(name) && !name.includes("--");
}
