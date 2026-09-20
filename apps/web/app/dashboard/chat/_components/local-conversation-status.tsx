"use client";
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import { authClient } from "../../../../lib/auth-client";
import {
  localRequest,
  type ExecutionInfo,
} from "../../../../lib/local-execution";
import { ensureLocalHostSession } from "../../../../lib/local-host-session";
import { isHubFileWindow } from "../../../../lib/hub-file-relay";
import {
  createLocalConversationStore,
  checkingConversation,
} from "../../../../lib/local-conversation-store";
import { subscribeLocalAvailabilityErrors } from "../../../../lib/local-availability-events";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

const stores = new Map<
  string,
  ReturnType<typeof createLocalConversationStore>
>();
export function useLocalConversationStatus(
  workspaceId?: string | null,
  threadId?: string | null,
) {
  const { data: session } = authClient.useSession();
  const account = session?.user.id;
  const sessionId = session?.session?.id;
  const scopeKey = JSON.stringify([account, sessionId, workspaceId, threadId]);
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId ?? "")}/threads/${encodeURIComponent(threadId ?? "")}`;
  const store = useMemo(() => {
    if (!workspaceId || !threadId || !account || !sessionId) return null;
    const key = JSON.stringify([account, sessionId, workspaceId, threadId]);
    let value = stores.get(key);
    if (!value) {
      value = createLocalConversationStore(
        async () => {
          // The detached Hub obtains proof through main; it never enrolls a host.
          const info = await localRequest<ExecutionInfo>(
            `${base}/local-execution`,
          );
          if (
            info.executionTarget.kind === "local" &&
            !isHubFileWindow() &&
            [
              "NATIVE_PROOF_EXPIRED",
              "REMOTE_ACCESS_DISABLED",
              "LOCAL_CONNECTION_REQUIRED",
            ].includes(info.availability?.code ?? "")
          ) {
            const proof = await ensureLocalHostSession(account);
            if (proof)
              return localRequest<ExecutionInfo>(`${base}/local-execution`);
          }
          return info;
        },
        (invalidate) =>
          subscribeLocalAvailabilityErrors((path) => {
            if (path.startsWith(`${base}/`)) invalidate();
          }),
      );
      stores.set(key, value);
    }
    return value;
  }, [account, sessionId, workspaceId, threadId, base]);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? getChecking,
    getChecking,
  );
  return {
    scopeKey,
    ...snapshot,
    refresh: async () => {
      await store?.refresh();
    },
    connect: async () => {
      const target = snapshot.info?.executionTarget;
      if (target?.kind !== "local") return;
      await localRequest(
        `/v1/local-devices/${encodeURIComponent(target.deviceId)}/connect`,
        {},
      );
      store?.invalidate();
      await store?.refresh();
    },
  };
}
const noopSubscribe = () => () => {};
const getChecking = () => checkingConversation;

export const LocalOperationContext = createContext<{
  blocked: boolean;
  message: string | null;
}>({ blocked: false, message: null });
export const useLocalOperationStatus = () => useContext(LocalOperationContext);

export function LocalConversationNotice({
  status,
}: {
  status: ReturnType<typeof useLocalConversationStatus>;
}) {
  const t = useTranslations("dashboardChat");
  if (status.ready) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b bg-muted/50 px-4 py-2 text-sm"
    >
      <div className="min-w-0 flex-1">
        {status.info?.target?.name && (
          <strong>{status.info.target.name} · </strong>
        )}
        {status.message} {t("local.historyPreserved")}
      </div>
      <button
        type="button"
        className="shrink-0 underline"
        onClick={() => void status.refresh()}
      >
        {t("local.checkAgain")}
      </button>
      {status.code === "LOCAL_CONNECTION_REQUIRED" && (
        <button
          type="button"
          className="shrink-0 underline"
          onClick={() =>
            void status.connect().catch((error) => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : t("local.couldNotConnect"),
              );
              void status.refresh();
            })
          }
        >
          {t("local.connectComputer")}
        </button>
      )}
    </div>
  );
}
