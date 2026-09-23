"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChatErrorRecovery } from "@/app/_components/chat-error-recovery";
import { authClient } from "@/lib/auth-client";
import { contentClient } from "@/lib/sdk";
import { requestThreadRunStop } from "@/lib/stop-thread-run";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";

type Run = Awaited<
  ReturnType<typeof contentClient.getActiveThreadRun>
>["threadRun"];

export function ChatRouteRecovery({ retry }: { retry: () => void }) {
  const { workspaceId } = useDashboardChatState();
  const params = useParams<{ threadId?: string }>();
  const { data } = authClient.useSession();
  const threadId = params?.threadId;
  return (
    <ChatErrorRecovery retry={retry}>
      {workspaceId && typeof threadId === "string" && data?.user.id ? (
        <RecoveryRunControl
          key={`${workspaceId}:${threadId}:${data.user.id}`}
          workspaceId={workspaceId}
          threadId={threadId}
          userId={data.user.id}
        />
      ) : null}
    </ChatErrorRecovery>
  );
}

export function RecoveryRunControl({
  workspaceId,
  threadId,
  userId,
}: {
  workspaceId: string;
  threadId: string;
  userId: string;
}) {
  const t = useTranslations("chatRecovery");
  const [run, setRun] = useState<Run>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<
    "runStatusError" | "stopError" | "stopped" | null
  >(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await contentClient.getActiveThreadRun(
        workspaceId,
        threadId,
      );
      if (mounted.current) setRun(result.threadRun);
    } catch {
      if (mounted.current) setMessage("runStatusError");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [workspaceId, threadId]);
  useEffect(() => {
    mounted.current = true;
    void check();
    return () => {
      mounted.current = false;
    };
  }, [check]);

  async function stop() {
    if (!run || run.userId !== userId || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const response = await requestThreadRunStop(
        workspaceId,
        threadId,
        run.idempotencyKey,
      );
      if (!response.ok) throw new Error("Stop failed");
      if (mounted.current) {
        setRun(null);
        setMessage("stopped");
      }
    } catch {
      if (mounted.current) setMessage("stopError");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="flex flex-col items-center gap-2 text-sm">
      {run?.userId === userId ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void stop()}
          className="rounded-md border px-4 py-2"
        >
          {t(busy ? "stopping" : "stop")}
        </button>
      ) : null}
      {run && run.userId !== userId ? <p>{t("otherRun")}</p> : null}
      {message ? <p role="status">{t(message)}</p> : null}
      <button type="button" disabled={busy} onClick={() => void check()}>
        {t("checkRun")}
      </button>
    </div>
  );
}
