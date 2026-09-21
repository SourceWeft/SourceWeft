/**
 * What a registry version's storage pointer says about where it came from:
 * `github:<owner>/<repo>@<40hex>#<subpath>`. The manifest names neither the
 * commit nor the directory, so this is where both are read from. A skill at
 * the repository root has no `#<subpath>` and its subpath is "". Null for a
 * pointer of any other shape — a builtin's, a custom skill's, a damaged one.
 */
export function parseGithubStoragePointer(
  storagePointer: string | null | undefined,
): {
  owner: string;
  repo: string;
  commitSha: string;
  repoSubpath: string;
} | null {
  if (typeof storagePointer !== "string") return null;
  const match =
    /^github:([^/@#\s]+)\/([^/@#\s]+)@([0-9a-fA-F]{40})(?:#(.*))?$/.exec(
      storagePointer,
    );
  if (!match) return null;
  const repoSubpath = (match[4] ?? "").replace(/^\/+|\/+$/g, "");
  // A directory inside the repository, or nothing: never a way out of it.
  if (repoSubpath.split("/").includes("..")) return null;
  return {
    owner: match[1]!,
    repo: match[2]!,
    commitSha: match[3]!.toLowerCase(),
    repoSubpath,
  };
}
