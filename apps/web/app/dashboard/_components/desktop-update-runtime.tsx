"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopBridge,
  desktopUpdates,
  type DesktopUpdateState,
} from "../../../lib/desktop-bridge";
import { flushChatDrafts } from "../../../lib/chat-drafts";

declare global {
  interface Window {
    __sourceweftSaveForUpdate?: () => Promise<void>;
    __sourceweftUnlockAfterUpdate?: () => void;
  }
}

export function DesktopUpdateRuntime() {
  const [operation, setOperation] = useState<string | null>(null);
  useEffect(() => {
    if (!desktopBridge.isAvailable()) return;
    const unlock = () => {
      if (window.top !== window) document.body.inert = false;
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          frame.contentWindow?.__sourceweftUnlockAfterUpdate?.();
        } catch {
          /* Unrelated cross-origin previews have no editable app draft. */
        }
      }
    };
    window.__sourceweftUnlockAfterUpdate = unlock;
    window.__sourceweftSaveForUpdate = async () => {
      if (window.top !== window) document.body.inert = true;
      if (document.querySelector('[data-update-unsaved="true"]'))
        throw new Error(
          "Save or finish your pending settings changes before installing an update.",
        );
      await flushChatDrafts();
      for (const frame of document.querySelectorAll("iframe")) {
        const src = new URL(frame.src, location.href);
        if (
          src.origin !== location.origin ||
          !src.pathname.startsWith("/dashboard/chat")
        )
          continue;
        const save = frame.contentWindow?.__sourceweftSaveForUpdate;
        if (!save)
          throw new Error("An embedded conversation is not ready to save.");
        await save();
      }
    };
    if (
      window.top !== window ||
      /\/dashboard\/(hub-window|preview-window)/.test(location.pathname)
    )
      return () => {
        unlock();
        delete window.__sourceweftUnlockAfterUpdate;
        delete window.__sourceweftSaveForUpdate;
      };
    let disposed = false;
    let revision = -1;
    let lastReady: string | null = null;
    let lastAvailable: string | null = null;
    const cleanup: Array<() => Promise<void>> = [];
    const receive = (state: DesktopUpdateState) => {
      if (disposed || state.revision < revision) return;
      revision = state.revision;
      if (
        !["preparing", "waitingForIdle", "installing"].includes(state.status)
      ) {
        setOperation(null);
        unlock();
      }
      if (
        state.status === "ready" &&
        (state.preferences?.snoozedUntil ?? 0) <= Date.now() / 1000 &&
        state.candidateId &&
        state.candidateId !== lastReady
      ) {
        lastReady = state.candidateId;
        const id = state.candidateId;
        toast("Update ready", {
          description: `SourceWeft ${state.version} is ready to install.`,
          action: {
            label: "Install and restart",
            onClick: () => {
              void desktopUpdates
                .install(id)
                .catch((e) => toast.error(String(e)));
            },
          },
        });
      }
      if (
        state.status === "available" &&
        state.preferences?.autoDownload === false &&
        (state.preferences.snoozedUntil ?? 0) <= Date.now() / 1000 &&
        state.candidateId &&
        state.candidateId !== lastAvailable
      ) {
        lastAvailable = state.candidateId;
        const id = state.candidateId;
        toast("Update available", {
          description: `SourceWeft ${state.version} is available.`,
          action: {
            label: "Download",
            onClick: () => {
              void desktopUpdates
                .download(id)
                .catch((e) => toast.error(String(e)));
            },
          },
        });
      }
    };
    void desktopBridge
      .info()
      .then(async (info) => {
        if (disposed || info.updaterProtocolVersion !== 1) return;
        const pending = [
          desktopUpdates.onState(receive),
          desktopUpdates.onSave(({ operationId }) => {
            setOperation(operationId);
            void (async () => {
              let error: string | null = null;
              try {
                const save = window.__sourceweftSaveForUpdate;
                if (!save) throw new Error("Draft saving is unavailable.");
                await save();
              } catch (e) {
                error = e instanceof Error ? e.message : String(e);
              }
              await desktopUpdates.saved(operationId, error);
            })().catch((e) => {
              setOperation(null);
              unlock();
              toast.error(String(e));
            });
          }),
        ];
        const subscriptions = await Promise.allSettled(pending);
        for (const entry of subscriptions)
          if (entry.status === "fulfilled") {
            if (disposed) await entry.value();
            else cleanup.push(entry.value);
          }
        const failed = subscriptions.find(
          (entry) => entry.status === "rejected",
        );
        if (failed?.status === "rejected") {
          for (const stop of cleanup.splice(0)) await stop();
          throw failed.reason;
        }
        receive(await desktopUpdates.state());
      })
      .catch((e) => {
        if (!disposed)
          toast.error(`Software update connection failed: ${String(e)}`);
      });
    return () => {
      disposed = true;
      unlock();
      delete window.__sourceweftUnlockAfterUpdate;
      delete window.__sourceweftSaveForUpdate;
      for (const stop of cleanup) void stop();
    };
  }, []);
  useEffect(() => {
    if (!operation) return;
    const block = (event: Event) => {
      if (!(
        event.target instanceof HTMLElement &&
        event.target.closest("[data-update-dialog]")
      )) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", block, true);
    document.addEventListener("beforeinput", block, true);
    return () => {
      document.removeEventListener("keydown", block, true);
      document.removeEventListener("beforeinput", block, true);
    };
  }, [operation]);
  if (!operation) return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Preparing software update"
        data-update-dialog
        className="max-w-sm space-y-4 rounded-xl border bg-card p-6 shadow-lg"
      >
        <h2 className="font-semibold">Preparing your update</h2>
        <p className="text-sm text-muted-foreground">
          Saving drafts and waiting for local work to finish. SourceWeft will
          restart when it is safe.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            void desktopUpdates
              .cancelInstall(operation)
              .catch((e) => toast.error(String(e)));
          }}
        >
          Cancel installation
        </Button>
      </div>
    </div>,
    document.body,
  );
}
