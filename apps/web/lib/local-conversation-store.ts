import type { ExecutionInfo } from "./local-execution";

export type ConversationSnapshot = {
  status: "checking" | "ready" | "unavailable" | "error";
  info: ExecutionInfo | null;
  ready: boolean;
  message: string | null;
  code: string | null;
};
export const checkingConversation: ConversationSnapshot = {
  status: "checking",
  info: null,
  ready: false,
  message: "Checking the computer connection…",
  code: null,
};

/** One poller per authenticated conversation; late results cannot unlock a new scope. */
export function createLocalConversationStore(
  read: () => Promise<ExecutionInfo>,
  subscribeInvalidation?: (invalidate: () => void) => () => void,
) {
  let snapshot = checkingConversation;
  let generation = 0;
  let busy: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopInvalidation: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (value: ConversationSnapshot) => {
    snapshot = value;
    for (const listener of listeners) listener();
  };
  const refresh = () => {
    // Execution targets are immutable. Once identified, cloud conversations do
    // not acquire a dependency on PC status polling or reconnect checks.
    if (snapshot.info?.executionTarget.kind === "cloud")
      return Promise.resolve();
    if (busy) return busy;
    const current = generation;
    const task = (async () => {
      try {
        const info = await read();
        if (current !== generation) return;
        const ready =
          info.executionTarget.kind === "cloud" ||
          info.availability?.ready === true;
        publish({
          status: ready ? "ready" : "unavailable",
          info,
          ready,
          code: info.availability?.code ?? null,
          message: ready
            ? null
            : (info.availability?.message ??
              "Could not verify the computer connection."),
        });
      } catch (error) {
        if (current !== generation) return;
        publish({
          status: "error",
          info: snapshot.info,
          ready: false,
          code: (error as { code?: string })?.code ?? null,
          message:
            error instanceof Error
              ? error.message
              : "Could not verify the computer connection.",
        });
      }
    })();
    busy = task;
    void task.finally(() => {
      if (busy === task) busy = undefined;
    });
    return task;
  };
  const visible = () => {
    if (document.visibilityState !== "hidden") {
      invalidate();
      void refresh();
    }
  };
  const invalidate = () => {
    if (snapshot.info?.executionTarget.kind === "cloud") return;
    generation++;
    busy = undefined;
    publish({
      ...snapshot,
      status: "checking",
      ready: false,
      message: "Checking the computer connection…",
    });
  };
  return {
    getSnapshot: () => snapshot,
    refresh,
    invalidate,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stopInvalidation = subscribeInvalidation?.(() => {
          invalidate();
          void refresh();
        });
        void refresh();
        timer = setInterval(() => {
          if (document.visibilityState !== "hidden") void refresh();
        }, 3000);
        document.addEventListener("visibilitychange", visible);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stopInvalidation?.();
          clearInterval(timer);
          document.removeEventListener("visibilitychange", visible);
          generation++;
          busy = undefined;
          snapshot = checkingConversation;
        }
      };
    },
  };
}
