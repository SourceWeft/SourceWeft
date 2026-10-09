import type { SkillManifestJson } from "@sourceweft/db";
/** Only a proven additive repair of formerly separated helper directories. */
export function canUpgradeSupportingBundle(input: {
  previous: SkillManifestJson;
  next: SkillManifestJson;
  previousFiles: readonly { path: string; contentHash: string }[];
  nextFiles: readonly { path: string; contentHash: string }[];
}): boolean {
  if (
    input.next.registry?.ingestion?.parserVersion !== "2" ||
    input.previous.registry?.ingestion?.parserVersion === "2"
  )
    return false;
  const roots = (input.next.registry.ingestion.diagnostics ?? [])
    .filter(
      (d) =>
        d.code === "SUPPORTING_SKILL_DOCUMENT" && d.file?.endsWith("/SKILL.md"),
    )
    .map((d) => d.file!.slice(0, -"SKILL.md".length));
  if (
    !roots.length ||
    !input.previousFiles.some((file) => file.path === "SKILL.md")
  )
    return false;
  const previous = new Map(
    input.previousFiles.map((file) => [file.path, file.contentHash]),
  );
  const next = new Map(
    input.nextFiles.map((file) => [file.path, file.contentHash]),
  );
  for (const [path, hash] of previous)
    if (next.get(path) !== hash) return false;
  const added = [...next.keys()].filter((path) => !previous.has(path));
  return (
    added.length > 0 &&
    added.every((path) => roots.some((root) => path.startsWith(root)))
  );
}
