/**
 * Path and name rules for skill material that ends up on a filesystem. Pure:
 * no IO, no `node:path` — every rule is about the `/`-separated string, so it
 * gives the same answer on every host OS.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/u;
const DRIVE_LETTER = /^[a-zA-Z]:/u;
/**
 * Device names Windows refuses (or misroutes) as a file name, with any
 * extension. Refused on every platform: a bundle that cannot be written on
 * Windows is not a portable skill.
 */
const RESERVED_ANYWHERE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * What only Windows minds — enforced when the bundle is being written on
 * Windows, so a file name that is fine on macOS and Linux keeps installing
 * there.
 *
 * `:` is the dangerous one: it starts an NTFS alternate data stream
 * (`SKILL.md:hidden` writes into a stream no directory listing shows), and
 * `C:x` in any segment is a drive-relative path that `path.resolve` follows out
 * of the directory it was joined to. The rest (`<>"|?*`) make the write fail
 * partway through an install.
 */
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/u;
/**
 * The wider reserved set: COM0-9 and LPT0-9 (also with the superscript digits
 * ¹ ² ³, which Windows 10 and later treat as digits here), the console handles
 * CONIN$ and CONOUT$, each with any extension, and with spaces allowed between
 * the name and the extension (`nul .txt`) by Win32 name normalisation.
 */
const RESERVED_ON_WINDOWS =
  /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/isu;

/**
 * Whether one path segment can be created as-is. Rejects `.`/`..`, a trailing
 * dot or space (Windows silently strips them, so two different names collapse
 * to one) and the common reserved device names everywhere; on Windows also the
 * characters it does not allow in a name (notably `:`) and its wider reserved
 * set. `platform` is the OS the file will be written on.
 */
export function isSafePathSegment(
  segment: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    RESERVED_ANYWHERE.test(segment)
  ) {
    return false;
  }
  return (
    platform !== "win32" ||
    (!WINDOWS_INVALID_CHARS.test(segment) && !RESERVED_ON_WINDOWS.test(segment))
  );
}

/**
 * A file path inside a skill bundle: relative, `/`-separated, and made only of
 * safe segments. Anything else — an absolute path, a backslash, a `..`
 * segment, an empty segment (`a//b`), a drive letter, a control character —
 * could resolve outside the directory the bundle is written into. On Windows a
 * drive-relative segment anywhere in the path (`a/C:x`) is refused too, through
 * the `:` rule in `isSafePathSegment`.
 */
export function isSafeBundlePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    DRIVE_LETTER.test(path) ||
    CONTROL_CHARS.test(path)
  ) {
    return false;
  }
  // An arrow, not the bare function: `every` would pass the index as `platform`.
  return path
    .split("/")
    .every((segment) => isSafePathSegment(segment, platform));
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
