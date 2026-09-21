"use client";

import * as React from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Label } from "@sourceweft/ui-web/components/ui/label";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import {
  describeSkillReportError,
  submitSkillReport,
  type SkillReportFailure,
  type SkillReportReason,
} from "../../../../../lib/skill-reports";
import { formatRetryWait, skillReportCopy } from "./skill-report-copy";

const copy = skillReportCopy.form;
const DETAILS_MAX_LENGTH = 4000;

const REASONS = Object.keys(skillReportCopy.reasons) as SkillReportReason[];

export function skillReportFailureMessage(failure: SkillReportFailure): string {
  switch (failure.kind) {
    case "rate_limited":
      return copy.errors.rateLimited(
        formatRetryWait(failure.retryAfterSeconds),
      );
    case "contact_required":
      return copy.errors.contactRequired;
    case "invalid":
      return copy.errors.invalid;
    case "not_found":
      return copy.errors.notFound;
    default:
      return copy.errors.unknown;
  }
}

export type SkillReportFormProps = {
  slug: string;
  /** Signed in: the email is optional. Signed out: it is required. */
  signedIn: boolean;
  /** Set to report one review of the skill rather than the skill. */
  reviewId?: string;
  /** Called after "Close" on the success state, or "Cancel". */
  onDone?: () => void;
};

/**
 * The report form, shared by the dashboard's report dialog and (later) the
 * public skill page: a reason, details, and a contact address that is
 * required only of a visitor who is not signed in. A report never changes
 * the skill; the form says so.
 */
export function SkillReportForm({
  slug,
  signedIn,
  reviewId,
  onDone,
}: SkillReportFormProps) {
  const id = React.useId();
  const [reason, setReason] = React.useState<SkillReportReason | "">("");
  const [details, setDetails] = React.useState("");
  const [contactEmail, setContactEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  const tooLong = details.length > DETAILS_MAX_LENGTH;
  const needsEmail = !signedIn && contactEmail.trim() === "";
  const canSubmit = !!reason && !tooLong && !needsEmail && !submitting;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitSkillReport(slug, {
        reason,
        details,
        contactEmail,
        reviewId,
      });
      setSent(true);
    } catch (failure) {
      setError(skillReportFailureMessage(describeSkillReportError(failure)));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-3" data-testid="skill-report-sent" role="status">
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
          {copy.successTitle}
        </p>
        <p className="text-sm text-muted-foreground">{copy.successBody}</p>
        {onDone ? (
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={onDone}>
              {copy.close}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-reason`}>{copy.reasonLabel}</Label>
        <select
          id={`${id}-reason`}
          name="reason"
          value={reason}
          onChange={(event) =>
            setReason(event.target.value as SkillReportReason | "")
          }
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          required
        >
          <option value="" disabled>
            {copy.reasonPlaceholder}
          </option>
          {REASONS.map((value) => (
            <option key={value} value={value}>
              {skillReportCopy.reasons[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-details`}>{copy.detailsLabel}</Label>
        <Textarea
          id={`${id}-details`}
          name="details"
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          placeholder={copy.detailsPlaceholder}
          rows={5}
          aria-invalid={tooLong || undefined}
        />
        {tooLong ? (
          <p className="text-xs text-destructive">
            {copy.errors.detailsTooLong(DETAILS_MAX_LENGTH)}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-email`}>{copy.contactLabel}</Label>
        <Input
          id={`${id}-email`}
          name="contactEmail"
          type="email"
          autoComplete="email"
          value={contactEmail}
          onChange={(event) => setContactEmail(event.target.value)}
          required={!signedIn}
        />
        <p className="text-xs text-muted-foreground">
          {signedIn ? copy.contactOptionalHint : copy.contactRequiredHint}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{copy.note}</p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            {copy.cancel}
          </Button>
        ) : null}
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {copy.submitting}
            </>
          ) : (
            copy.submit
          )}
        </Button>
      </div>
    </form>
  );
}
