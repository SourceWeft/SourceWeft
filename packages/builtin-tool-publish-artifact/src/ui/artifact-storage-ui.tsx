"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, ShieldAlert, Database, RotateCcw } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  describeArtifactLinkHost,
  type ArtifactRecordPerson,
  type ArtifactRecordsStatus,
  type ArtifactRecordsTransport,
} from "@sourceweft/contracts/artifact-records";
import {
  DEFAULT_ARTIFACT_STORAGE_TEXT,
  formatArtifactText,
  type ArtifactStorageText,
} from "@sourceweft/contracts/artifact-storage-text";

/** Long query strings and fragments are how a page would smuggle data out. */
const DATA_CARRYING_LINK_CHARS = 120;

/**
 * Leave-SourceWeft confirmation. Rendered inside the preview stage (not a
 * portal) so it also works while the stage is fullscreen. Focus starts on
 * Cancel: continuing is always a deliberate second action.
 */
export function ExternalLinkPrompt({
  url,
  onCancel,
  onContinue,
  text = DEFAULT_ARTIFACT_STORAGE_TEXT,
}: {
  url: URL;
  onCancel: () => void;
  onContinue: () => void;
  text?: ArtifactStorageText;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const host = describeArtifactLinkHost(url.hostname);
  const carriesData =
    url.search.length + url.hash.length > DATA_CARRYING_LINK_CHARS;
  const full = url.href;
  const shown =
    expanded || full.length <= 160 ? full : `${full.slice(0, 160)}…`;
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-link-title"
        className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      >
        <h2
          id="artifact-link-title"
          className="flex items-center gap-2 text-base font-semibold"
        >
          <ExternalLink className="size-4" />
          {text.linkTitle}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{text.linkIntro}</p>
        <p
          className="mt-4 break-all text-lg font-semibold"
          data-testid="artifact-link-host"
        >
          {host.unicode}
        </p>
        {host.isInternationalized && (
          <p className="text-xs text-muted-foreground">
            {text.linkShownAs} <span className="font-mono">{host.ascii}</span>
          </p>
        )}
        <p className="mt-3 break-all rounded bg-muted/40 p-2 font-mono text-xs">
          {shown}
          {shown !== full && (
            <button
              type="button"
              className="ml-1 underline"
              onClick={() => setExpanded(true)}
            >
              {text.linkShowAll}
            </button>
          )}
        </p>
        {carriesData && (
          <p
            role="note"
            className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
          >
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            {text.linkLongWarning}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancel} variant="secondary" size="sm" onClick={onCancel}>
            {text.cancel}
          </Button>
          <Button size="sm" onClick={onContinue}>
            {text.continue}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NavigatedAwayNotice({
  onReload,
  text = DEFAULT_ARTIFACT_STORAGE_TEXT,
}: {
  onReload: () => void;
  text?: ArtifactStorageText;
}) {
  return (
    <div
      role="alert"
      className="grid h-full min-h-80 place-items-center p-6 text-center"
    >
      <div className="max-w-sm space-y-3">
        <p className="text-sm font-medium">{text.navigatedAway}</p>
        <Button size="sm" variant="secondary" onClick={onReload}>
          <RotateCcw className="size-3.5" />
          {text.reloadPage}
        </Button>
      </div>
    </div>
  );
}

/** Renders a sentence whose `<strong>…</strong>` span is emphasised. */
function Emphasised({ template }: { template: string }) {
  return (
    <>
      {template.split(/(<strong>.*?<\/strong>)/su).map((part, index) => {
        const inner = /^<strong>(.*)<\/strong>$/su.exec(part)?.[1];
        return inner === undefined ? (
          part
        ) : (
          <strong key={index}>{inner}</strong>
        );
      })}
    </>
  );
}

/** A calm heads-up, not a warning: reports are advisory and nothing changes. */
export function NavigationAttemptsNote({
  count,
  text = DEFAULT_ARTIFACT_STORAGE_TEXT,
}: {
  count: number;
  text?: ArtifactStorageText;
}) {
  if (!count || count < 1) return null;
  return (
    <p className="text-muted-foreground" data-testid="artifact-navigation-note">
      {formatArtifactText(
        count === 1 ? text.navigationAttemptsOne : text.navigationAttemptsOther,
        { count },
      )}
    </p>
  );
}

/**
 * Prompts for a version that declares storage: a quiet note for personal
 * storage, and the approval / consent steps a version needs before it can
 * reach records other people wrote. The page's requests fail with
 * `forbidden` or `consent_required` until these are done.
 */
export function ArtifactStorageBar({
  transport,
  shared,
  text = DEFAULT_ARTIFACT_STORAGE_TEXT,
}: {
  transport: ArtifactRecordsTransport;
  shared: boolean;
  text?: ArtifactStorageText;
}) {
  const personName = (person: ArtifactRecordPerson | null) =>
    person?.name || text.memberFallback;
  const [status, setStatus] = useState<ArtifactRecordsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const refresh = useCallback(async () => {
    if (!transport.status) return;
    try {
      setStatus(await transport.status());
      setError(null);
    } catch {
      setError(text.statusError);
    }
  }, [transport, text.statusError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(action: (() => Promise<void>) | undefined) {
    if (!action) return;
    setBusy(true);
    try {
      await action();
      setReviewing(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : text.actionError);
    } finally {
      setBusy(false);
    }
  }

  if (!transport.status) return null;
  const sharedState = status?.shared ? status : null;
  return (
    <div
      className="border-b bg-muted/10 px-3 py-2 text-xs"
      data-testid="artifact-storage-bar"
    >
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Database className="size-3.5" />
        {text.ownData}
      </p>
      {shared && sharedState && !sharedState.approval && (
        <div
          className="mt-2 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          role="region"
          aria-label={text.approvalRegionLabel}
          data-testid="artifact-approval-pending"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-200">
            <ShieldAlert className="size-4 shrink-0" />
            {sharedState.canApprove
              ? text.waitingForYourApproval
              : text.waitingForApproval}
          </p>
          <p>
            <Emphasised template={text.approvalAsk} />{" "}
            {sharedState.canApprove ? text.approverHint : text.nonApproverHint}
          </p>
          <NavigationAttemptsNote
            count={sharedState.navigationAttempts}
            text={text}
          />
          {sharedState.canApprove && !reviewing && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setReviewing(true)}
            >
              {text.reviewRequest}
            </Button>
          )}
          {reviewing && (
            <div className="space-y-2 rounded border bg-background p-3">
              <p>
                {formatArtifactText(text.reviewBody, {
                  author: personName(sharedState.author),
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setReviewing(false)}
                >
                  {text.cancel}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(transport.approveShared)}
                >
                  {text.approveVersion}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {shared && sharedState?.approval && !sharedState.consented && (
        <div
          className="mt-2 space-y-2"
          role="region"
          aria-label={text.consentRegionLabel}
        >
          <p>{text.consentBody}</p>
          <p className="text-muted-foreground">
            {formatArtifactText(text.consentMeta, {
              author: personName(sharedState.author),
              approver: personName(sharedState.approval.approvedBy),
            })}
          </p>
          <NavigationAttemptsNote
            count={sharedState.navigationAttempts}
            text={text}
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act(transport.grantSharedConsent)}
          >
            {text.allowSharedData}
          </Button>
        </div>
      )}
      {shared && sharedState?.approval && sharedState.consented && (
        <p className="mt-1 text-muted-foreground">
          {formatArtifactText(text.sharedDataOn, {
            approver: personName(sharedState.approval.approvedBy),
          })}
          {sharedState.canApprove && transport.revokeShared && (
            <button
              type="button"
              className="ml-2 underline"
              disabled={busy}
              onClick={() => void act(transport.revokeShared)}
            >
              {text.revokeApproval}
            </button>
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
