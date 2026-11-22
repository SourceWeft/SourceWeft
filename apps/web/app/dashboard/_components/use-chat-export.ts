"use client";

import { useCallback, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { contentClient } from "../../../lib/sdk";
import { saveBlob } from "../../../lib/save-blob";

export type ChatExportDeps = {
  exportThread: (
    workspaceId: string,
    threadId: string,
    input: { locale: string; timeZone: string },
  ) => Promise<{ blob: Blob; fileName: string | null }>;
  save: (blob: Blob, fileName: string) => void;
};

const defaultDeps: ChatExportDeps = {
  exportThread: (workspaceId, threadId, input) =>
    contentClient.exportThread(workspaceId, threadId, input),
  save: saveBlob,
};

/**
 * Downloads a chat as Markdown (a zip when it has images), with a loading
 * toast while the server builds it. A second request for a chat that is still
 * exporting is ignored.
 */
export function useChatExport(
  workspaceId: string | null,
  deps: ChatExportDeps = defaultDeps,
) {
  const locale = useLocale();
  const t = useTranslations("dashboardNav");
  const inFlight = useRef(new Set<string>());

  return useCallback(
    async (chatId: string) => {
      if (!workspaceId || inFlight.current.has(chatId)) return;
      inFlight.current.add(chatId);
      const toastId = toast.loading(t("chats.exporting"));
      try {
        const { blob, fileName } = await deps.exportThread(
          workspaceId,
          chatId,
          {
            locale,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        );
        deps.save(blob, fileName ?? "chat.md");
        toast.dismiss(toastId);
      } catch {
        toast.error(t("chats.exportError"), { id: toastId });
      } finally {
        inFlight.current.delete(chatId);
      }
    },
    [deps, locale, t, workspaceId],
  );
}
