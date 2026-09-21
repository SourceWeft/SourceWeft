"use client";

import * as React from "react";
import { EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import type { SkillReviewViewer } from "../../../../../lib/skill-reviews";
import { SkillReviewEditor } from "./skill-review-editor";
import { SkillReviewItem } from "./skill-review-item";

/**
 * The viewer's own review: what they wrote (marked when a moderator hid it),
 * a form to write or change it, or why they cannot. `onSave` and `onDelete`
 * resolve true when done, which closes the form; false keeps it open.
 */
export function SkillReviewOwn({
  viewer,
  busy,
  onSave,
  onDelete,
}: {
  viewer: SkillReviewViewer;
  busy: boolean;
  onSave: (input: { rating: number; body: string }) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const t = useTranslations("dashboardSkillReviews");
  const own = viewer.ownReview;
  const [editing, setEditing] = React.useState(false);

  // Nobody signed in reaches the dashboard; the public page handles that case.
  if (viewer.reason === "signed_out") return null;

  const deleteButton = own ? (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={busy}
      onClick={() => void onDelete()}
    >
      {busy ? <Loader2 className="animate-spin" /> : null}
      {t("delete")}
    </Button>
  ) : null;

  return (
    <section
      data-testid="skill-review-own"
      aria-label={t("yourReview")}
      className="rounded-xl border border-border bg-muted/20 p-3"
    >
      <h3 className="text-sm font-medium text-foreground">
        {own ? t("yourReview") : t("writeReview")}
      </h3>
      {own?.status === "hidden" ? (
        <p
          data-testid="skill-review-own-hidden"
          className="mt-2 flex items-start gap-2 text-xs text-muted-foreground"
        >
          <EyeOff aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {t("hiddenNotice")}
        </p>
      ) : null}
      {!viewer.canReview ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("notInstalled")}
          </p>
          {own ? (
            <SkillReviewItem review={own} actions={deleteButton} />
          ) : null}
        </>
      ) : own && !editing ? (
        <SkillReviewItem
          review={own}
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                {t("edit")}
              </Button>
              {deleteButton}
            </>
          }
        />
      ) : (
        <div className="mt-3">
          <SkillReviewEditor
            key={own?.updatedAt ?? "new"}
            initialRating={own?.rating ?? 0}
            initialBody={own?.body ?? ""}
            busy={busy}
            onCancel={own ? () => setEditing(false) : undefined}
            onSave={(input) => {
              void onSave(input).then((done) => {
                if (done) setEditing(false);
              });
            }}
          />
        </div>
      )}
    </section>
  );
}
