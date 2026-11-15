"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { HttpClientError } from "@sourceweft/sdk";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { contentClient } from "../../../../lib/sdk";

type Problem = "conflict" | "indexing" | null;

/**
 * Edits a saved note's text. Saving re-indexes the note, so what is searched
 * and cited is what it now says. If someone else changed it in the meantime
 * the save is refused and nothing is overwritten; if indexing fails the new
 * text is kept and saving again retries it.
 */
export function NoteEditor({
  expectedUpdatedAt,
  initialText,
  onCancel,
  onChanged,
  onSaved,
  sourceId,
  workspaceId,
}: {
  /** The note's current `updatedAt`; read on every save so a retry uses the latest. */
  expectedUpdatedAt: string;
  initialText: string;
  onCancel: () => void;
  /** The note changed on the server even though the save did not finish. */
  onChanged: () => void;
  onSaved: () => void;
  sourceId: string;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [draft, setDraft] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const unchanged = draft === initialText;
  const empty = draft.trim().length === 0;

  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      await contentClient.updateNoteContent(workspaceId, sourceId, {
        contentText: draft,
        expectedUpdatedAt,
      });
      toast.success(t("noteEditor.saved"));
      onSaved();
    } catch (error) {
      if (error instanceof HttpClientError && error.status === 409) {
        setProblem("conflict");
      } else {
        // The text is stored before indexing, so the note did change.
        setProblem("indexing");
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : t("noteEditor.saveFailed"),
        );
        onChanged();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3 px-5 py-4 lg:px-8">
      <Textarea
        aria-label={t("noteEditor.label")}
        className="min-h-[40vh] flex-1 font-mono text-sm leading-6"
        data-note-editor
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        value={draft}
      />
      <p className="text-xs text-muted-foreground">{t("noteEditor.hint")}</p>

      {problem === "conflict" ? (
        <p className="text-sm text-destructive" data-note-conflict role="alert">
          {t("noteEditor.conflict")}
        </p>
      ) : null}
      {problem === "indexing" ? (
        <p className="text-sm text-destructive" data-note-indexing role="alert">
          {t("noteEditor.indexingFailed")}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          disabled={saving}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          {problem === "conflict"
            ? t("noteEditor.reload")
            : t("noteEditor.cancel")}
        </Button>
        <Button
          disabled={
            saving ||
            empty ||
            (unchanged && problem === null) ||
            problem === "conflict"
          }
          onClick={() => void save()}
          size="sm"
          type="button"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {saving ? t("noteEditor.saving") : t("noteEditor.save")}
        </Button>
      </div>
    </div>
  );
}
