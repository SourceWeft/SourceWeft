/**
 * The words of the artifact storage prompts: shared-data approval and consent,
 * the leave-SourceWeft confirmation, and the navigation notices. Packages hold
 * no copy of their own; the app supplies a translated object through the
 * artifact render host, and these English strings are the fallback so the UI
 * still works without one.
 *
 * `{name}` placeholders are filled by `formatArtifactText`. The one sentence
 * with emphasis carries a `<strong>…</strong>` marker.
 */
export type ArtifactStorageText = {
  linkTitle: string;
  linkIntro: string;
  /** Followed by the ASCII form of an internationalized host name. */
  linkShownAs: string;
  linkShowAll: string;
  linkLongWarning: string;
  cancel: string;
  continue: string;
  navigatedAway: string;
  reloadPage: string;
  /** `{count}` is above zero. */
  navigationAttemptsOne: string;
  navigationAttemptsOther: string;
  ownData: string;
  statusError: string;
  actionError: string;
  /** Used where a person's name is unknown. */
  memberFallback: string;
  approvalRegionLabel: string;
  waitingForYourApproval: string;
  waitingForApproval: string;
  /** One sentence; `<strong>…</strong>` marks the emphasised words. */
  approvalAsk: string;
  approverHint: string;
  nonApproverHint: string;
  reviewRequest: string;
  /** `{author}` */
  reviewBody: string;
  approveVersion: string;
  consentRegionLabel: string;
  consentBody: string;
  /** `{author}`, `{approver}` */
  consentMeta: string;
  allowSharedData: string;
  /** `{approver}` */
  sharedDataOn: string;
  revokeApproval: string;
};

export const DEFAULT_ARTIFACT_STORAGE_TEXT: ArtifactStorageText = {
  linkTitle: "Leaving SourceWeft",
  linkIntro:
    "This page wants to open a website outside SourceWeft. Only continue if you trust it.",
  linkShownAs: "Shown in the browser as",
  linkShowAll: "Show all",
  linkLongWarning:
    "This link is long and may carry information from the page to that website.",
  cancel: "Cancel",
  continue: "Continue",
  navigatedAway:
    "This page tried to go to another address, so it was stopped and its storage was disconnected.",
  reloadPage: "Reload page",
  navigationAttemptsOne:
    "This version has tried to leave its page {count} time recently.",
  navigationAttemptsOther:
    "This version has tried to leave its page {count} times recently.",
  ownData: "This page saves data under your account.",
  statusError: "Could not check this page's storage access.",
  actionError: "That did not work.",
  memberFallback: "a workspace member",
  approvalRegionLabel: "Shared data approval",
  waitingForYourApproval: "Waiting for your approval",
  waitingForApproval: "Waiting for approval",
  approvalAsk:
    "This version asks to read and change <strong>shared data</strong> that everyone who can open it sees. It cannot use shared data until it is approved.",
  approverHint: "Review the request before approving.",
  nonApproverHint: "Only a workspace editor or admin can approve this version.",
  reviewRequest: "Review request",
  reviewBody:
    "Approving lets this exact version, written by {author}, read and change shared data, including what other members enter. A page can send what it reads outside SourceWeft. New versions need a new approval.",
  approveVersion: "Approve this version",
  consentRegionLabel: "Shared data consent",
  consentBody:
    "This page can read and change shared data, including what other members entered, and could send it outside SourceWeft. Don't store anything sensitive here.",
  consentMeta: "Version by {author}, approved by {approver}.",
  allowSharedData: "Allow shared data",
  sharedDataOn: "Shared data is on for this version (approved by {approver}).",
  revokeApproval: "Revoke approval",
};

/** Fills `{name}` placeholders; an unknown placeholder is left as written. */
export function formatArtifactText(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/gu, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
