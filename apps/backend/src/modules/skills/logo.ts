import type { SkillManifestJson } from "@sourceweft/db";
import { skillLogoSchema } from "@sourceweft/contracts";

/** Old imports get publisher attribution without rewriting immutable versions. */
export function getSkillLogo(manifest: SkillManifestJson) {
  if (manifest.logo) {
    const result = skillLogoSchema.safeParse(manifest.logo);
    if (result.success) return result.data;
  }
  if (!manifest.registry) return undefined;
  try {
    const repo = new URL(manifest.registry.repoUrl);
    const owner = repo.pathname.split("/")[1];
    if (
      repo.protocol !== "https:" ||
      repo.hostname !== "github.com" ||
      !owner ||
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)
    )
      return undefined;
    return {
      url: `https://github.com/${owner}.png?size=128`,
      source: "publisher" as const,
    };
  } catch {
    return undefined;
  }
}
