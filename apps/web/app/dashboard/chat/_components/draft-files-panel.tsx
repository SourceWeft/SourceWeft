"use client";

import { Folder } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  WorkingFolderPicker,
  type ChatCreationContext,
} from "./chat-work-context";
import { LocalFilesBrowser } from "./local-files-panel";

export type DraftWorkContext = Pick<
  ChatCreationContext,
  "target" | "nativeId" | "selectedDevice" | "ready" | "error"
> & { disabled?: boolean };

export function DraftFilesPanel({
  context,
  onFolderChange,
  onChooseFolder,
  searchQuery = "",
}: {
  context?: DraftWorkContext;
  onFolderChange?: (folderId: string) => void;
  onChooseFolder?: () => Promise<void>;
  searchQuery?: string;
}) {
  const t = useTranslations("dashboardChatFiles.draftFiles");
  if (!context || !context.ready || !context.target)
    return (
      <p
        role={context?.error ? "alert" : "status"}
        className="p-4 text-sm text-muted-foreground"
      >
        {context?.error ?? t("loadingLocation")}
      </p>
    );
  if (context.target.kind === "cloud")
    return (
      <section className="space-y-2 p-4 text-sm">
        <h3 className="font-medium">{t("cloudTitle")}</h3>
        <p className="text-muted-foreground">{t("cloudDescription")}</p>
      </section>
    );
  const { target, selectedDevice } = context;
  const message =
    context.error ??
    (!selectedDevice?.online
      ? t("offline")
      : !selectedDevice.connected
        ? t("connectToBrowse")
        : "");
  return (
    <section className="space-y-3">
      <div className="space-y-2 p-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Folder className="size-4" />
          {target.folderId ? t("workingDirectory") : t("conversationFolder")}
        </h3>
        <p className="text-xs text-muted-foreground">{selectedDevice?.name}</p>
        {!target.folderId && (
          <p className="text-sm text-muted-foreground">
            {t("autoFolderHint")}
          </p>
        )}
        {onFolderChange && (
          <WorkingFolderPicker
            creation={{ ...context, setFolder: onFolderChange }}
            onChooseFolder={onChooseFolder}
            disabled={context.disabled || !!message}
          />
        )}
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
        {target.deviceId !== context.nativeId && (
          <p className="text-xs text-muted-foreground">
            {t("authorizeHint")}
          </p>
        )}
      </div>
      {target.folderId && (
        <LocalFilesBrowser
          key={`${target.deviceId}:${target.folderId}`}
          variant="hub"
          computerName={selectedDevice?.name}
          searchQuery={searchQuery}
          availability={{ ready: !message, message }}
          basePath={`/v1/local-devices/${encodeURIComponent(target.deviceId)}/folders/${encodeURIComponent(target.folderId)}/files`}
        />
      )}
    </section>
  );
}
