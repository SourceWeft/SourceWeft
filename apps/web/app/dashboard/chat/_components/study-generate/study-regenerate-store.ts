import type { StudyVersionRef } from "@sourceweft/builtin-tool-study/ui";
import { createRegenerateRequestStore } from "../artifact-preview/regenerate-request-store";

/**
 * Where a study viewer's "regenerate" (retry a failure, refresh a stale set)
 * lands: `requestStudyRegenerate` (the host's `requestRegenerate`) records it
 * and `StudyRegenerateDialogHost`, mounted next to every capability-owned
 * preview, opens the generate dialog pre-filled from the recipe.
 */
export const studyRegenerateStore = createRegenerateRequestStore();

export function requestStudyRegenerate(ref: StudyVersionRef): Promise<void> {
  return studyRegenerateStore.request(ref);
}
