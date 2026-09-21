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
