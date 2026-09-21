import type { useTranslations } from "next-intl";

/**
 * Which version an "update" moves an install to. `currentVersionId` is the
 * skill's published current version as the catalog reports it; the version
 * list is only a fallback, because it is paged by age and the current version
 * is not always on the first page.
 */
export function resolveUpdateTarget(input: {
  installedVersionId: string | null | undefined;
  currentVersionId?: string | null;
  versions?: ReadonlyArray<{ id: string; isCurrent: boolean; status: string }>;
}) {
  if (!input.installedVersionId) return null;
  const current =
    input.currentVersionId ??
    input.versions?.find(
      (version) => version.isCurrent && version.status === "published",
    )?.id ??
    null;
  return current && current !== input.installedVersionId ? current : null;
}

type VersionChangelog = {
  added: readonly string[];
  removed: readonly string[];
  modified: readonly string[];
  newScripts: readonly string[];
  newFlags: readonly string[];
  compareUrl: string | null;
};

/**
 * The update notice's one line about a version: "3 files, 1 new script" and a
 * GitHub compare link. Scripts and scan flags are named apart from the file
 * count because they are what changes what the skill can do. The link is only
 * ever a github.com https address.
 */
export function summarizeVersionChangelog(
  changelog: VersionChangelog,
  // The `dashboardSkillsMarket` translator: reads `updates.*`.
  t: ReturnType<typeof useTranslations>,
) {
  const files =
    changelog.added.length +
    changelog.removed.length +
    changelog.modified.length;
  const parts = [
    files > 0
      ? t("updates.changedFiles", { count: files })
      : t("updates.noFileChanges"),
    changelog.newScripts.length > 0
      ? t("updates.newScripts", { count: changelog.newScripts.length })
      : null,
    changelog.newFlags.length > 0
      ? t("updates.newFlags", { count: changelog.newFlags.length })
      : null,
  ].filter((part): part is string => part !== null);
  let compareUrl: string | null = null;
  try {
    const url = changelog.compareUrl ? new URL(changelog.compareUrl) : null;
    if (url && url.protocol === "https:" && url.hostname === "github.com") {
      compareUrl = url.toString();
    }
  } catch {
    compareUrl = null;
  }
  return {
    summary: parts.join(t("updates.listSeparator")),
    compareUrl,
    escalates:
      changelog.newScripts.length > 0 || changelog.newFlags.length > 0,
  };
}
