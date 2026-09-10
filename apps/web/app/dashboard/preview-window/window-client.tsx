"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, X } from "lucide-react";
import { Preview } from "@sourceweft/preview/react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { authClient } from "../../../lib/auth-client";
import {
  desktopPreviewBridge,
  type DesktopPreviewFile,
} from "../../../lib/desktop-preview-bridge";

export function DesktopPreviewWindow() {
  const id = useSearchParams().get("id");
  const { data: session, isPending } = authClient.useSession();
  const [file, setFile] = useState<{
    metadata: DesktopPreviewFile;
    blob: Blob;
  }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (isPending || !id) return;
    let live = true;
    setFile(undefined);
    setError(undefined);
    void desktopPreviewBridge
      .read(id)
      .then((metadata) => {
        if (!live) return;
        if (metadata.accountId !== session?.user.id) {
          void desktopPreviewBridge.close();
          throw new Error("This preview belongs to a different account.");
        }
        const blob = new Blob(
          [Uint8Array.from(atob(metadata.base64), (c) => c.charCodeAt(0))],
          { type: metadata.mimeType },
        );
        setFile({ metadata: { ...metadata, base64: "" }, blob });
        document.title = `${metadata.name.split(/[\\/]/).pop()} · SourceWeft`;
      })
      .catch((cause) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [id, isPending, session?.user.id]);

  const close = () =>
    void desktopPreviewBridge.close().catch((cause) => setError(cause.message));
  const download = () => {
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.metadata.name.split(/[\\/]/).pop() || "file";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1
            className="min-w-0 flex-1 truncate text-sm font-semibold"
            title={file?.metadata.name}
          >
            {file?.metadata.name.split(/[\\/]/).pop() ?? "File preview"}
          </h1>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Download file"
            disabled={!file}
            onClick={download}
          >
            <Download className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close preview window"
            onClick={close}
          >
            <X className="size-4" />
          </Button>
        </div>
        {file && (
          <p
            className="mt-1 truncate text-xs text-muted-foreground"
            title={file.metadata.description}
          >
            {file.metadata.description}
          </p>
        )}
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {error ? (
          <p role="alert" className="p-6 text-sm text-destructive">
            {error}
          </p>
        ) : !file ? (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            Loading file preview…
          </p>
        ) : !file.blob.size ? (
          <p className="p-6 text-sm text-muted-foreground">
            This file is empty.
          </p>
        ) : (
          <Preview
            key={id}
            source={{
              name: file.metadata.name,
              mimeType: file.metadata.mimeType,
              blob: file.blob,
            }}
          />
        )}
      </div>
    </div>
  );
}
