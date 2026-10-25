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
}: {
  url: URL;
  onCancel: () => void;
  onContinue: () => void;
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
          Leaving SourceWeft
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This page wants to open a website outside SourceWeft. Only continue if
          you trust it.
        </p>
        <p
          className="mt-4 break-all text-lg font-semibold"
          data-testid="artifact-link-host"
        >
          {host.unicode}
        </p>
        {host.isInternationalized && (
          <p className="text-xs text-muted-foreground">
            Shown in the browser as{" "}
            <span className="font-mono">{host.ascii}</span>
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
              Show all
            </button>
          )}
        </p>
        {carriesData && (
          <p
            role="note"
            className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
          >
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            This link is long and may carry information from the page to that
            website.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancel} variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onContinue}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NavigatedAwayNotice({ onReload }: { onReload: () => void }) {
  return (
    <div
      role="alert"
      className="grid h-full min-h-80 place-items-center p-6 text-center"
    >
      <div className="max-w-sm space-y-3">
        <p className="text-sm font-medium">
          This page tried to go to another address, so it was stopped and its
          storage was disconnected.
        </p>
        <Button size="sm" variant="secondary" onClick={onReload}>
          <RotateCcw className="size-3.5" />
          Reload page
        </Button>
      </div>
    </div>
  );
}

/** A calm heads-up, not a warning: reports are advisory and nothing changes. */
export function NavigationAttemptsNote({ count }: { count: number }) {
  if (!count || count < 1) return null;
  return (
    <p className="text-muted-foreground" data-testid="artifact-navigation-note">
      This version has tried to leave its page {count}{" "}
      {count === 1 ? "time" : "times"} recently.
    </p>
  );
}

function personName(person: ArtifactRecordPerson | null) {
  return person?.name || "a workspace member";
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
}: {
  transport: ArtifactRecordsTransport;
  shared: boolean;
}) {
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
      setError("Could not check this page's storage access.");
    }
  }, [transport]);

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
      setError(cause instanceof Error ? cause.message : "That did not work.");
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
        This page saves data under your account.
      </p>
      {shared && sharedState && !sharedState.approval && (
        <div className="mt-2 space-y-2">
          <p>
            This version asks to read and change <strong>shared data</strong>{" "}
            that everyone who can open it sees.{" "}
            {sharedState.canApprove
              ? "Review it before approving."
              : "A workspace editor or admin has to approve this version first."}
          </p>
          <NavigationAttemptsNote count={sharedState.navigationAttempts} />
          {sharedState.canApprove && !reviewing && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setReviewing(true)}
            >
              Review request
            </Button>
          )}
          {reviewing && (
            <div className="space-y-2 rounded border bg-background p-3">
              <p>
                Approving lets this exact version, written by{" "}
                {personName(sharedState.author)}, read and change shared data,
                including what other members enter. A page can send what it
                reads outside SourceWeft. New versions need a new approval.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setReviewing(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(transport.approveShared)}
                >
                  Approve this version
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
          aria-label="Shared data consent"
        >
          <p>
            This page can read and change shared data, including what other
            members entered, and could send it outside SourceWeft. Don&apos;t
            store anything sensitive here.
          </p>
          <p className="text-muted-foreground">
            Version by {personName(sharedState.author)}, approved by{" "}
            {personName(sharedState.approval.approvedBy)}.
          </p>
          <NavigationAttemptsNote count={sharedState.navigationAttempts} />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act(transport.grantSharedConsent)}
          >
            Allow shared data
          </Button>
        </div>
      )}
      {shared && sharedState?.approval && sharedState.consented && (
        <p className="mt-1 text-muted-foreground">
          Shared data is on for this version (approved by{" "}
          {personName(sharedState.approval.approvedBy)}).
          {sharedState.canApprove && transport.revokeShared && (
            <button
              type="button"
              className="ml-2 underline"
              disabled={busy}
              onClick={() => void act(transport.revokeShared)}
            >
              Revoke approval
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
