"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { parseTableContent, type TableColumnInput } from "@sourceweft/contracts/table";
import { contentClient } from "../../../../../lib/sdk";
import { invalidateArtifactDetail } from "../sources-hub/artifacts/artifact-detail-loader";
import type { ArtifactListItem } from "../sources-hub/types";
import { TableGenerateDialog, type TableGenerateSource } from "./table-generate-dialog";
import {
  clearTableRegenerate,
  registerTableRegenerateHost,
  subscribeTableRegenerate,
  tableRegenerateState,
} from "./table-regenerate-store";

type Recipe = {
  token: number;
  workspaceId: string;
  artifactId: string;
  threadId: string;
  sources: TableGenerateSource[];
  columns: TableColumnInput[];
  instruction: string;
};

/**
 * What a regeneration starts from: the current version's recipe, with each
 * source's title from its row. Null when the version cannot be read (a table
 * whose first generation failed has none).
 */
function readRecipe(
  artifact: ArtifactListItem,
): Omit<Recipe, "token" | "workspaceId" | "artifactId" | "threadId"> | null {
  try {
    const content = parseTableContent(artifact.payloadJson);
    const titles = new Map(content.rows.map((row) => [row.sourceId, row.title]));
    const { recipe } = content.generation;
    return {
      sources: recipe.sourceIds.map((id) => ({ id, title: titles.get(id) || id })),
      columns: recipe.columns,
      instruction: recipe.instruction ?? "",
    };
  } catch {
    return null;
  }
}

const serverState = { request: null, owner: null } as const;

/**
 * Answers the table viewer's "regenerate": loads the table, then opens the
 * generate dialog pre-filled from its recipe, column ids included, so the
 * columns that did not change keep their cells and only new ones are billed.
 */
export function TableRegenerateDialogHost() {
  const t = useTranslations("table");
  const [id] = useState(() => Symbol("table-regenerate-host"));
  const { request, owner } = useSyncExternalStore(
    subscribeTableRegenerate,
    tableRegenerateState,
    () => serverState,
  );
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const answering = owner === id && request !== null;

  useEffect(() => registerTableRegenerateHost(id), [id]);

  useEffect(() => {
    if (!answering || !request) return;
    let cancelled = false;
    const { token, workspaceId, artifactId } = request;
    contentClient
      .getArtifact(workspaceId, artifactId)
      .then(({ artifact }) => {
        if (cancelled) return;
        const read = readRecipe(artifact);
        if (!read || !artifact.threadId) {
          toast.error(t("generate.errors.recipeUnavailable"));
          clearTableRegenerate(token);
          return;
        }
        setRecipe({ ...read, token, workspaceId, artifactId, threadId: artifact.threadId });
      })
      .catch(() => {
        if (cancelled) return;
        toast.error(t("generate.errors.loadFailed"));
        clearTableRegenerate(token);
      });
    return () => {
      cancelled = true;
    };
  }, [answering, request, t]);

  if (!answering || !request || recipe?.token !== request.token) return null;
  return (
    <TableGenerateDialog
      initialColumns={recipe.columns}
      initialInstruction={recipe.instruction}
      onOpenChange={(open) => {
        if (!open) clearTableRegenerate(recipe.token);
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
