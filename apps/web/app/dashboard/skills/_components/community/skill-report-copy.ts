import type {
  SkillReportAction,
  SkillReportReason,
  SkillReportStatus,
} from "../../../../../lib/skill-reports";

/**
 * English UI text for skill reports (§17.2): the report form and the market
 * admins' reports queue. Localized later with the rest of the market copy.
 */
export const skillReportCopy = {
  reasons: {
    copyright: "Copyright or license violation",
    malicious: "Malicious or unsafe",
    impersonation: "Impersonates someone else",
    spam: "Spam or misleading",
    broken: "Broken or does not work",
    other: "Something else",
  } satisfies Record<SkillReportReason, string>,
  form: {
    reasonLabel: "What is wrong?",
    reasonPlaceholder: "Choose a reason",
    detailsLabel: "Details",
    detailsPlaceholder:
      "What should the market admins look at? Links and specifics help.",
    contactLabel: "Contact email",
    contactOptionalHint: "Optional. Only market admins see it.",
    contactRequiredHint: "Required, so an admin can reply. Only admins see it.",
    submit: "Send report",
    submitting: "Sending…",
    cancel: "Cancel",
    note: "A report does not take the skill down by itself. A market admin reviews it.",
    successTitle: "Report sent",
    successBody:
      "Thank you. A market admin will review it. Nothing changes until they do.",
    close: "Close",
    errors: {
      rateLimited: (wait: string | null) =>
        wait
          ? `You have sent too many reports. Try again in ${wait}.`
          : "You have sent too many reports. Try again later.",
      contactRequired: "Please leave an email address so an admin can reply.",
      invalid:
        "Check the form: a reason is required, and the email must be valid.",
      notFound: "This skill (or review) can no longer be reported.",
      unknown: "The report could not be sent. Try again.",
      detailsTooLong: (max: number) =>
        `Keep the details under ${max} characters.`,
    },
  },
  button: {
    label: "Report",
    title: "Report this skill",
    description:
      "Tell the market admins about a problem with this skill: a copied work, unsafe behavior, spam, or something broken.",
  },
  admin: {
    title: "Reports",
    description:
      "Reports from users and visitors about community skills and their reviews. Resolving one is recorded in the market audit log.",
    statuses: {
      open: "Open",
      actioned: "Actioned",
      dismissed: "Dismissed",
    } satisfies Record<SkillReportStatus, string>,
    statusFilterLabel: "Status",
    empty: {
      open: "No open reports.",
      actioned: "No actioned reports.",
      dismissed: "No dismissed reports.",
    } satisfies Record<SkillReportStatus, string>,
    loadError: "Reports could not be loaded.",
    retry: "Retry",
    loadMore: "Load more",
    loading: "Loading…",
    anonymous: "anonymous",
    reportedBy: "Reported by",
    contact: "Contact",
    account: "Account",
    aboutReview: "About a review",
    reviewHidden: "hidden",
    noDetails: "No details given.",
    otherOpen: (count: number) =>
      count === 1
        ? "1 other open report on this skill"
        : `${count} other open reports on this skill`,
    visibility: {
      public: "Public",
      restricted: "Not public",
    } as Record<string, string>,
    held: "Held",
    resolution: "Resolution",
    resolvedBy: "Resolved by",
    resolutionLabel: "Resolution note (optional)",
    resolutionPlaceholder: "What was decided and why",
    alsoResolve: "Also resolve other open reports on the same target",
    actions: {
      dismiss: "Dismiss",
      withdraw_skill: "Withdraw skill",
      revoke_version: "Revoke current version",
      hide_review: "Hide review",
      none: "Mark handled",
    } satisfies Record<SkillReportAction, string>,
    confirm: {
      withdraw_skill:
        "Withdraw this skill from the public market? Installed workspaces keep it.",
      revoke_version:
        "Revoke the skill's current version? The best older version, if any, becomes current.",
      hide_review: "Hide this review from the skill's page?",
    } as Partial<Record<SkillReportAction, string>>,
    confirmAction: "Confirm",
    cancel: "Cancel",
    resolveError: "The report could not be resolved.",
    resolved: (count: number) =>
      count > 1 ? `Resolved ${count} reports.` : "Report resolved.",
  },
};

/** "45 minutes", "2 hours": how long until the reporter may try again. */
export function formatRetryWait(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds < 90) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
