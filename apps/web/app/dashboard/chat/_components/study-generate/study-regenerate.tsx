"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  parseStudyContentForArtifact,
  studyArtifactTypeSchema,
  type StudyArtifactType,
  type StudyOptions,
} from "@sourceweft/contracts/study";
import { contentClient } from "../../../../../lib/sdk";
import { EMPTY_REGENERATE_REQUEST_STATE } from "../artifact-preview/regenerate-request-store";
import { invalidateArtifactDetail } from "../sources-hub/artifacts/artifact-detail-loader";
import type { ArtifactListItem } from "../sources-hub/types";
import { StudyGenerateDialog, type StudyGenerateSource } from "./study-generate-dialog";
import { studyRegenerateStore } from "./study-regenerate-store";

type Recipe = {
  token: number;
  workspaceId: string;
  artifactId: string;
  threadId: string;
  artifactType: StudyArtifactType;
  sources: StudyGenerateSource[];
  options: StudyOptions;
};

/**
 * What a regeneration starts from: the current version's recipe (options and
 * focus; the sources stay the recipe's). Null when the version cannot be read
 * (a set whose first generation failed has none).
 */
export function readStudyRecipe(
  artifact: Pick<ArtifactListItem, "artifactType" | "payloadJson">,
): Pick<Recipe, "artifactType" | "sources" | "options"> | null {
  const type = studyArtifactTypeSchema.safeParse(artifact.artifactType);
  if (!type.success) return null;
  try {
    const content = parseStudyContentForArtifact(type.data, artifact.payloadJson);
    const { recipe } = content.generation;
    const focus = recipe.focus ?? recipe.options.focus;
    return {
      artifactType: type.data,
      sources: recipe.sourceIds.map((id) => ({ id, title: id })),
      options: { ...recipe.options, ...(focus !== undefined ? { focus } : {}) },
    };
  } catch {
    return null;
  }
}

/**
 * Answers a study viewer's "regenerate": loads the artifact, then opens the
 * generate dialog pre-filled from its recipe.
 */
export function StudyRegenerateDialogHost() {
  const t = useTranslations("study");
  const [id] = useState(() => Symbol("study-regenerate-host"));
  const { request, owner } = useSyncExternalStore(
    studyRegenerateStore.subscribe,
    studyRegenerateStore.getState,
    () => EMPTY_REGENERATE_REQUEST_STATE,
  );
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const answering = owner === id && request !== null;

  useEffect(() => studyRegenerateStore.registerHost(id), [id]);

  useEffect(() => {
    if (!answering || !request) return;
    let cancelled = false;
    const { token, workspaceId, artifactId } = request;
    contentClient
      .getArtifact(workspaceId, artifactId)
      .then(({ artifact }) => {
        if (cancelled) return;
        const read = readStudyRecipe(artifact);
        if (!read || !artifact.threadId) {
          toast.error(t("generate.errors.recipeUnavailable"));
          studyRegenerateStore.clear(token);
          return;
        }
        setRecipe({ ...read, token, workspaceId, artifactId, threadId: artifact.threadId });
        studyRegenerateStore.answer(token);
      })
      .catch(() => {
        if (cancelled) return;
        toast.error(t("generate.errors.loadFailed"));
        studyRegenerateStore.clear(token);
      });
    return () => {
      cancelled = true;
    };
  }, [answering, request, t]);

  if (!answering || !request || recipe?.token !== request.token) return null;
  return (
    <StudyGenerateDialog
      artifactType={recipe.artifactType}
      initialOptions={recipe.options}
      onOpenChange={(open) => {
        if (!open) studyRegenerateStore.clear(recipe.token);
      }}
      onQueued={() => invalidateArtifactDetail(recipe.workspaceId, recipe.artifactId)}
      open
      sources={recipe.sources}
      target={{
        kind: "regenerate",
        threadId: recipe.threadId,
        artifactId: recipe.artifactId,
      }}
      workspaceId={recipe.workspaceId}
    />
  );
}
