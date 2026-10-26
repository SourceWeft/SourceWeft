"use client";

import * as React from "react";
import { Database, Loader2, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import {
  ARTIFACT_RECORD_LIMITS,
  artifactRecordCollectionSchema,
  type ArtifactSharedCollection,
} from "@sourceweft/contracts/artifact-records";
import { contentClient } from "../../../../../lib/sdk";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; collections: ArtifactSharedCollection[] };

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((name) => b.includes(name));
}

/**
 * Chooses which of an artifact's shared data collections a public share page
 * may read. Collections the artifact actually has are toggles with their record
 * counts; a name already public (or typed in) that has no data yet stays
 * listed, marked as such, and can be removed. Saving is the caller's job.
 */
export function PublicCollectionsPicker({
  workspaceId,
  artifactId,
  saved,
  onSave,
}: {
  workspaceId: string;
  artifactId: string;
  /** Collections currently public on the share. */
  saved: readonly string[];
  onSave: (collections: string[]) => Promise<void>;
}) {
  const t = useTranslations("dashboardChatFiles");
  const [load, setLoad] = React.useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = React.useState(0);
  const savedKey = saved.join("\n");
  const [draft, setDraft] = React.useState<string[]>([...saved]);
  const [newName, setNewName] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);

  React.useEffect(() => {
    setDraft(savedKey ? savedKey.split("\n") : []);
  }, [savedKey]);

  React.useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    contentClient
      .listArtifactSharedCollections(workspaceId, artifactId)
      .then((response) => {
        if (!cancelled)
          setLoad({ status: "ready", collections: response.collections });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, artifactId, reloadKey]);

  const limit = ARTIFACT_RECORD_LIMITS.publicCollections;
  const atLimit = draft.length >= limit;
  const existing = load.status === "ready" ? load.collections : [];
  const existingNames = new Set(existing.map((entry) => entry.collection));
  const withoutData = draft.filter((name) => !existingNames.has(name));

  function setPublic(name: string, isPublic: boolean) {
    setDraft((current) =>
      isPublic
        ? current.includes(name)
          ? current
          : [...current, name]
        : current.filter((value) => value !== name),
    );
  }

  function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    const parsed = artifactRecordCollectionSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(t("toasts.publicRecordsInvalid"));
      return;
    }
    if (!draft.includes(name) && atLimit) {
      setNameError(t("share.publicRecordsLimit", { count: limit }));
      return;
    }
    setPublic(name, true);
    setNewName("");
    setNameError(null);
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      await onSave(draft);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{t("share.publicRecords")}</p>
        <p className="text-xs leading-5 text-muted-foreground">
          {t("share.publicRecordsDescription")}
        </p>
      </div>

      {load.status === "loading" ? (
        <div
          className="flex items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-3.5 animate-spin" />
          {t("share.publicRecordsLoading")}
        </div>
      ) : null}

      {load.status === "error" ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
          role="alert"
        >
          <span className="text-xs text-destructive">
            {t("share.publicRecordsLoadFailed")}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            {t("actions.tryAgain")}
          </Button>
        </div>
      ) : null}

      {load.status === "ready" &&
      existing.length === 0 &&
      withoutData.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("share.publicRecordsEmpty")}
        </p>
      ) : null}

      {existing.length > 0 || withoutData.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {existing.map((entry) => {
            const checked = draft.includes(entry.collection);
            return (
              <li
                key={entry.collection}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <Database className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {entry.collection}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t("share.publicRecordsCount", { count: entry.count })}
                  </span>
                  <Switch
                    className="ml-auto"
                    aria-label={entry.collection}
                    checked={checked}
                    disabled={!checked && atLimit}
                    onCheckedChange={(value) =>
                      setPublic(entry.collection, value)
                    }
                  />
                </label>
              </li>
            );
          })}
          {withoutData.map((name) => (
            <li
              key={name}
              className="flex items-center justify-between gap-3 px-3 py-2"
              data-no-data
            >
              <span className="flex min-w-0 items-center gap-2">
                <Database className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("share.publicRecordsNoData")}
                </span>
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("share.publicRecordsRemove", { name })}
                onClick={() => setPublic(name, false)}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Input
            aria-label={t("share.publicRecordsAddLabel")}
            value={newName}
            placeholder={t("share.publicRecordsPlaceholder")}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => {
              setNewName(event.target.value);
              setNameError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleAdd();
              }
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!newName.trim()}
            onClick={handleAdd}
          >
            <Plus className="size-3.5" />
            {t("share.publicRecordsAdd")}
          </Button>
        </div>
        {nameError ? (
          <p className="text-xs text-destructive" role="alert">
            {nameError}
          </p>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          disabled={sameSet(draft, saved) || isSaving}
          onClick={() => void handleSave()}
        >
          {t("actions.save")}
        </Button>
      </div>
    </div>
  );
}
