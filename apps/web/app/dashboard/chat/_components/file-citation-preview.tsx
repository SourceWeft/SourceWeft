"use client";

import { useEffect, useMemo, useState } from "react";
import { Preview } from "@sourceweft/preview/react";
import type { FileLocator, FileReference } from "@sourceweft/contracts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { contentClient } from "../../../../lib/sdk";
import { localRequest } from "../../../../lib/local-execution";
import { readLocalPreviewBlob } from "../../../../lib/local-file-preview";

export function fileLocationLabel(locator: FileLocator): string {
  switch (locator.kind) {
    case "page":
      return `Page ${locator.page}`;
    case "slide":
      return `Slide ${locator.slide}`;
    case "paragraph":
      return `Paragraph ${locator.index + 1}`;
    case "cells":
      return `${locator.sheet} · ${locator.range}`;
    case "lines":
      return locator.start === locator.end
        ? `Line ${locator.start}`
        : `Lines ${locator.start}–${locator.end}`;
    case "image":
      return "Image";
  }
}

export function FileCitationPreview({
  reference,
  excerpt,
  open,
  onOpenChange,
}: {
  reference: FileReference;
  excerpt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const key = JSON.stringify(reference);
  const [tab, setTab] = useState<"excerpt" | "original">("excerpt");
  const [allowCurrent, setAllowCurrent] = useState(false);
  const [state, setState] = useState<{
    key: string;
    blob?: Blob;
    matches?: boolean;
    error?: string;
  } | null>(null);
  useEffect(() => {
    setTab(reference.presentation === "visual" ? "original" : "excerpt");
    setAllowCurrent(false);
    if (!open) return;
    const controller = new AbortController();
    setState({ key });
    void (async () => {
      const file = reference.file;
      let blob: Blob;
      if (file.backendKind === "cloud_vfs") {
        blob = await contentClient.readFileBlob(
          reference.workspaceId,
          reference.threadId,
          `/files/${file.relativePath}`,
          controller.signal,
        );
      } else {
        const base = `/v1/workspaces/${encodeURIComponent(reference.workspaceId)}/threads/${encodeURIComponent(reference.threadId)}/local-files`;
        const { root } = await localRequest<{ root: string }>(base, {
          signal: controller.signal,
        });
        blob = await readLocalPreviewBlob(
          `${base}?download=true&path=${encodeURIComponent(`${root}/${file.relativePath}`)}`,
          controller.signal,
        );
      }
      const hash = [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
        ),
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      if (!controller.signal.aborted)
        setState({ key, blob, matches: file.revision === `sha256:${hash}` });
    })().catch((error: unknown) => {
      if (!controller.signal.aborted)
        setState({
          key,
          error:
            error instanceof Error ? error.message : "File is unavailable.",
        });
    });
    return () => controller.abort();
  }, [key, open, reference]);
  const current = state?.key === key ? state : null;
  const source = useMemo(
    () =>
      current?.blob
        ? {
            name: reference.file.name,
            mimeType: reference.file.mimeType,
            blob: current.blob,
          }
        : null,
    [current?.blob, reference.file.name, reference.file.mimeType],
  );
  const location = useMemo(() => {
    if (!current?.matches) return undefined;
    const locator = reference.locator;
    if (locator.kind === "page") return { page: locator.page };
    if (locator.kind === "slide") return { page: locator.slide };
    if (locator.kind === "lines" && reference.file.mimeType !== "text/markdown")
      return { line: locator.start };
    if (locator.kind === "paragraph") return { quote: excerpt };
    return undefined;
  }, [current?.matches, reference.locator, reference.file.mimeType, excerpt]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(800px,calc(100svh-2rem))] w-[1000px] max-w-[calc(100%-2rem)] flex-col gap-3"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>{reference.file.name}</DialogTitle>
          <DialogDescription>
            Files ·{" "}
            {reference.file.backendKind === "local_fs"
              ? "This computer"
              : "Cloud"}{" "}
            · {fileLocationLabel(reference.locator)}
            {reference.file.origin === "agent_created"
              ? " · AI-created file"
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button
            variant={tab === "excerpt" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab("excerpt")}
          >
            Cited excerpt
          </Button>
          <Button
            variant={tab === "original" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab("original")}
          >
            Original file
          </Button>
        </div>
        {current?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {current.error}
          </p>
        ) : current?.matches === false ? (
          <p role="status" className="text-sm text-muted-foreground">
            File changed since cited. The excerpt below belongs to the cited
            version.
          </p>
        ) : !current?.blob ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking file version…
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {reference.file.relativePath} · Cited version verified
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === "excerpt" ? (
            <pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 text-sm">
              {excerpt}
            </pre>
          ) : source && (current?.matches || allowCurrent) ? (
            <Preview source={source} location={location} className="h-full" />
          ) : current?.matches === false ? (
            <Button onClick={() => setAllowCurrent(true)}>
              Open current version
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
