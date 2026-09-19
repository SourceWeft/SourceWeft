"use client";

import { Folder } from "lucide-react";
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
  if (!context || !context.ready || !context.target)
    return (
      <p
        role={context?.error ? "alert" : "status"}
        className="p-4 text-sm text-muted-foreground"
      >
        {context?.error ?? "Loading file location…"}
      </p>
    );
  if (context.target.kind === "cloud")
    return (
      <section className="space-y-2 p-4 text-sm">
        <h3 className="font-medium">Conversation cloud files</h3>
        <p className="text-muted-foreground">
          Files you upload and create after starting this conversation will be
          saved here.
        </p>
      </section>
    );
  const { target, selectedDevice } = context;
  const message =
    context.error ??
    (!selectedDevice?.online
      ? "This computer is offline. Your folder selection is preserved."
      : !selectedDevice.connected
        ? "Connect to this computer to browse its files."
        : "");
  return (
    <section className="space-y-3">
      <div className="space-y-2 p-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Folder className="size-4" />
          {target.folderId ? "Working directory" : "Conversation folder"}
        </h3>
        <p className="text-xs text-muted-foreground">{selectedDevice?.name}</p>
        {!target.folderId && (
          <p className="text-sm text-muted-foreground">
            An independent folder will be created automatically on this computer
            when the conversation starts using files.
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
            To authorize another folder, open SW on this computer. You can
            select an already authorized folder here.
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
