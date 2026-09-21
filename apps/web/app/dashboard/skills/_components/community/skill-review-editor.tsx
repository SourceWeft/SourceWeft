"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { SKILL_REVIEW_BODY_MAX_LENGTH } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { SkillReviewStarPicker } from "./skill-review-stars";

/**
 * Text with a live count against the API's limit. The limit counts the text
 * as sent — trimmed — which is never longer than what is typed.
 */
function CountedTextarea({
  id,
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const t = useTranslations("dashboardSkillReviews");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        maxLength={SKILL_REVIEW_BODY_MAX_LENGTH}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-24"
      />
      <span
        data-testid="skill-review-char-count"
        className="self-end text-xs tabular-nums text-muted-foreground"
      >
        {t("charCount", {
          count: value.length,
          max: SKILL_REVIEW_BODY_MAX_LENGTH,
        })}
      </span>
    </div>
  );
}

/**
 * The viewer's own review: a rating and optional text. Holds only what is
 * being typed; saving is the caller's (`onSave`), which rejects to keep the
 * form open.
 */
export function SkillReviewEditor({
  initialRating = 0,
  initialBody = "",
  busy,
  onSave,
  onCancel,
}: {
  initialRating?: number;
  initialBody?: string;
  busy?: boolean;
  onSave: (input: { rating: number; body: string }) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations("dashboardSkillReviews");
  const id = React.useId();
  const [rating, setRating] = React.useState(initialRating);
  const [body, setBody] = React.useState(initialBody);
  return (
    <form
      data-testid="skill-review-editor"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (rating < 1 || busy) return;
        onSave({ rating, body: body.trim() });
      }}
    >
      <SkillReviewStarPicker
        value={rating}
        onChange={setRating}
        disabled={busy}
      />
      <CountedTextarea
        id={`${id}-body`}
        label={t("bodyLabel")}
        value={body}
        onChange={setBody}
        disabled={busy}
        placeholder={t("bodyPlaceholder")}
      />
      <div className="flex items-center justify-end gap-2">
        {rating < 1 ? (
          <span className="mr-auto text-xs text-muted-foreground">
            {t("chooseRating")}
          </span>
        ) : null}
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onCancel}
          >
            {t("cancel")}
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={busy || rating < 1}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

/** The repository author's reply to one review. */
export function SkillReviewReplyEditor({
  initialBody = "",
  busy,
  onSave,
  onCancel,
}: {
  initialBody?: string;
  busy?: boolean;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("dashboardSkillReviews");
  const id = React.useId();
  const [body, setBody] = React.useState(initialBody);
  const empty = body.trim().length === 0;
  return (
    <form
      data-testid="skill-review-reply-editor"
      className="mt-1 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (empty || busy) return;
        onSave(body.trim());
      }}
    >
      <CountedTextarea
        id={`${id}-reply`}
        label={t("replyLabel")}
        value={body}
        onChange={setBody}
        disabled={busy}
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onCancel}
        >
          {t("cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={busy || empty}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {t("saveReply")}
        </Button>
      </div>
    </form>
  );
}
