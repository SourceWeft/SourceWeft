"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { GlobeIcon } from "lucide-react";
import type { LocalNetworkDecision, LocalNetworkRequest } from "@sourceweft/sdk";
import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { localDevicesClient } from "../../../../../lib/sdk";
import type { ActiveThreadRun } from "../../[threadId]/chat-stream-runner-control";
import {
  classifyNetworkResponseError,
  formatNetworkRemaining,
  networkRequestRemainingMs,
  visibleNetworkRequests,
} from "./network-access-state";
import {
  buildTrustPayload,
  defaultTrustDurationChoiceId,
  getTrustDurationChoices,
} from "./tool-confirmation-trust";
import { useNetworkRequests } from "./use-network-requests";

type MessageKey = "forbidden" | "onceOnly" | "failed";

function NetworkRequestCard({
  now,
  onAnswered,
  request,
  workspaceId,
}: {
  now: number;
  onAnswered: (id: string) => void;
  request: LocalNetworkRequest;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardChatCanvas");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const [trustDurationId, setTrustDurationId] = useState(
    defaultTrustDurationChoiceId,
  );
  const durationChoices = getTrustDurationChoices(t);
  // A missing kind comes from an older backend and means a plain host request.
  const isWriteRequest = request.kind === "request";
  const remaining = networkRequestRemainingMs(request, now);

  async function respond(decision: LocalNetworkDecision) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await localDevicesClient.respondNetworkRequest(workspaceId, request.id, {
        decision,
        ...(decision === "allow_always"
          ? { trust: buildTrustPayload(trustDurationId) }
          : {}),
      });
      onAnswered(request.id);
    } catch (error) {
      const failure = classifyNetworkResponseError(error);
      if (failure === "gone") {
        onAnswered(request.id);
        return;
      }
      setMessage(failure);
      setBusy(false);
    }
  }

  return (
    <Alert
      className="flex min-h-0 flex-col gap-2"
      data-testid="network-access-card"
    >
      <AlertDescription className="block min-h-0 [overflow-wrap:anywhere]">
        <div className="flex items-start gap-2">
          <GlobeIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 space-y-1">
            <span className="block text-sm font-medium text-foreground">
              {isWriteRequest ? (
                t("networkAccess.requestTitle", { host: request.host })
              ) : (
                <>
                  {t("networkAccess.title")}
                  {" · "}
                  <span className="font-mono">
                    {t("networkAccess.target", {
                      host: request.host,
                      port: request.port,
                    })}
                  </span>
                </>
              )}
            </span>
            <span className="block text-xs leading-5 text-muted-foreground">
              {isWriteRequest
                ? t("networkAccess.requestIntro")
                : t("networkAccess.intro")}
            </span>
            {isWriteRequest ? (
              <>
                <code
                  className="block max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs leading-5"
                  data-testid="network-request-line"
                >
                  {[request.method, request.host, request.path]
                    .filter(Boolean)
                    .join(" ")}
                </code>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {t("networkAccess.requestHelper")}
                </span>
              </>
            ) : null}
            {request.suggestedBy ? (
              <span className="block text-xs text-muted-foreground">
                {t("networkAccess.requestedBy", { skill: request.suggestedBy })}
              </span>
            ) : null}
            <span className="block text-xs text-muted-foreground">
              {t("networkAccess.commandLabel")}
            </span>
            <code className="block max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs leading-5">
              {request.commandPreview}
            </code>
            <span className="block text-xs text-muted-foreground">
              {t("networkAccess.expiresIn", {
                time: formatNetworkRemaining(remaining),
              })}
            </span>
          </div>
        </div>
      </AlertDescription>
      {message ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`networkAccess.${message}`)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 pt-2">
        {isWriteRequest ? null : (
          <label className="mr-auto flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {t("toolConfirmation.rememberFor")}
            <select
              aria-label={t("toolConfirmation.rememberAria")}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              disabled={busy}
              onChange={(event) => setTrustDurationId(event.target.value)}
              value={trustDurationId}
            >
              {durationChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          disabled={busy}
          onClick={() => void respond("deny")}
          size="sm"
          variant="destructive"
        >
          {t("networkAccess.deny")}
        </Button>
        <Button
          disabled={busy}
          onClick={() => void respond("allow_once")}
          size="sm"
        >
          {busy
            ? t("networkAccess.sending")
            : isWriteRequest
              ? t("networkAccess.allowWrites")
              : t("networkAccess.allowOnce")}
        </Button>
        {isWriteRequest ? null : (
          <Button
            disabled={busy}
            onClick={() => void respond("allow_always")}
            size="sm"
            variant="outline"
          >
            {t("networkAccess.allowWorkspace")}
          </Button>
        )}
      </div>
    </Alert>
  );
}

/**
 * Pending outbound-network approvals of a local conversation, shown above the
 * composer next to the tool-approval bar. Answering never touches the chat
 * run: the command keeps executing and the device acts on the answer.
 */
export function NetworkAccessBar({
  activeThreadRun,
  className,
  isLocalThread,
  threadId,
  workspaceId,
}: {
  activeThreadRun?: ActiveThreadRun | null;
  className?: string;
  isLocalThread: boolean;
  threadId: string | null | undefined;
  workspaceId: string | null | undefined;
}) {
  const t = useTranslations("dashboardChatCanvas");
  const polling = isLocalThread && Boolean(activeThreadRun);
  const { requests, remove } = useNetworkRequests({
    workspaceId,
    threadId,
    enabled: polling,
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (requests.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [requests.length]);

  const visible = visibleNetworkRequests(requests, now);
  if (!workspaceId || visible.length === 0) return null;

  return (
    <div
      aria-label={t("networkAccess.region")}
      className={cn(
        "min-h-0 max-h-[min(480px,45svh)] shrink-0 space-y-2 overflow-y-auto border-t border-border/70 bg-background/95 px-3 py-2 backdrop-blur sm:px-4",
        className,
      )}
      role="region"
    >
      <div className="mx-auto w-full max-w-4xl space-y-2">
        {visible.map((request) => (
          <NetworkRequestCard
            key={request.id}
            now={now}
            onAnswered={remove}
            request={request}
            workspaceId={workspaceId}
          />
        ))}
      </div>
    </div>
  );
}
