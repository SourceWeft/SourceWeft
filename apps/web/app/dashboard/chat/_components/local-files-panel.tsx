"use client";

import { useEffect, useRef, useState } from "react";
import {
  File,
  Folder,
  ArrowUp,
  RefreshCw,
  Download,
  X,
  Eye,
  ChevronRight,
} from "lucide-react";
import { localRequest } from "../../../../lib/local-execution";
import { downloadLocalFile } from "../../../../lib/local-file-download";
import { FilePreviewDialog } from "./file-preview-dialog";
import { basename } from "./workfile-content-preview";
import { readLocalPreviewBlob } from "../../../../lib/local-file-preview";
import type { PreviewSource } from "@sourceweft/preview";

type Directory = {
  root: string;
  path: string;
  files: Array<{ path: string; is_dir?: boolean; size?: number }>;
};
type Preview = {
  path: string;
  status: "loading" | "ready" | "error";
  source?: PreviewSource;
  error?: string;
};
type LocalFilesPanelProps = {
  workspaceId: string;
  threadId: string;
  onClose?: () => void;
  variant?: "panel" | "hub";
  computerName?: string;
  searchQuery?: string;
};

/** Changing conversations must discard the previous directory and open preview. */
export function LocalFilesPanel(props: LocalFilesPanelProps) {
  return (
    <LocalFilesBrowser
      key={`${props.workspaceId}:${props.threadId}`}
      {...props}
    />
  );
}

function LocalFilesBrowser({
  workspaceId,
  threadId,
  onClose,
  variant = "panel",
  computerName,
  searchQuery = "",
}: LocalFilesPanelProps) {
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [path, setPath] = useState<string>();
  const [previewPath, setPreviewPath] = useState<string>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/local-files`;
  const sourceLabel = computerName
    ? `This computer · ${computerName}`
    : "Stored on this computer";

  // Listing and preview requests have separate lifecycles. Opening a file does
  // not reset the list, scroll position, current directory or search results.
  useEffect(() => {
    let live = true;
    let busy = false;
    setDirectory(null);
    setError(undefined);
    setLoading(true);
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await localRequest<Directory>(
          `${base}${path ? `?path=${encodeURIComponent(path)}` : ""}`,
        );
        if (live) {
          setDirectory(result);
          setError(undefined);
        }
      } catch (cause) {
        if (live) {
          setDirectory(null);
          setError(cause instanceof Error ? cause.message : String(cause));
          setPreviewPath(undefined);
          setPreview(null);
        }
      } finally {
        busy = false;
        if (live) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [base, path, revision]);

  useEffect(() => {
    if (!previewPath) return;
    const requestedPath = previewPath;
    const controller = new AbortController();
    let live = true;
    let busy = false;
    setPreview({ path: requestedPath, status: "loading" });
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const blob = await readLocalPreviewBlob(
          `${base}?path=${encodeURIComponent(requestedPath)}&download=true`,
          controller.signal,
        );
        if (live)
          setPreview({
            path: requestedPath,
            status: "ready",
            source: { name: requestedPath, blob },
          });
      } catch (cause) {
        if (live)
          setPreview({
            path: requestedPath,
            status: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          });
      } finally {
        busy = false;
      }
    };
    void refresh();
    return () => {
      live = false;
      controller.abort();
    };
  }, [base, previewPath, previewRevision]);

  const visiblePreview = preview?.path === previewPath ? preview : null;
  const visibleFiles =
    directory?.files.filter(
      (file) =>
        !searchQuery.trim() ||
        file.path.toLowerCase().includes(searchQuery.trim().toLowerCase()),
    ) ?? [];
  const download = (filePath: string, fromPreview = false) => {
    void downloadLocalFile(
      `${base}?path=${encodeURIComponent(filePath)}&download=true`,
      basename(filePath),
    ).catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (fromPreview)
        setPreview({ path: filePath, status: "error", error: message });
      else setError(message);
    });
  };

  return (
    <section
      aria-label="Local files"
      className={
        variant === "hub"
          ? "flex min-h-0 flex-col bg-background"
          : "flex max-h-[50vh] shrink-0 flex-col border-b bg-background"
      }
    >
      <header className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
        <Folder size={16} />
        <strong>{variant === "hub" ? "Workfiles" : "Files"}</strong>
        <span className="text-xs text-muted-foreground">{sourceLabel}</span>
        <button
          type="button"
          aria-label="Refresh files"
          onClick={() => setRevision((value) => value + 1)}
          className="ml-auto rounded p-1 hover:bg-accent"
        >
          <RefreshCw size={15} />
        </button>
        {onClose && (
          <button
            type="button"
            aria-label="Close files"
            onClick={onClose}
            className="rounded p-1 hover:bg-accent"
          >
            <X size={15} />
          </button>
        )}
      </header>
      {directory && (
        <div className="flex items-center gap-2 border-y px-4 py-1 text-xs">
          <button
            type="button"
            aria-label="Parent folder"
            disabled={directory.path === directory.root}
            onClick={() =>
              setPath(directory.path.slice(0, directory.path.lastIndexOf("/")))
            }
            className="shrink-0 rounded p-1 disabled:opacity-30"
          >
            <ArrowUp size={14} />
          </button>
          <span className="break-all font-mono">{directory.path}</span>
        </div>
      )}
      {loading && (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Loading files from the computer…
        </p>
      )}
      {error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {directory && (
        <div className="min-h-0 overflow-auto p-2">
          {directory.files.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">
              This folder is empty. Files created here will appear
              automatically.
            </p>
          )}
          {directory.files.length > 0 && visibleFiles.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">
              No files match your search.
            </p>
          )}
          {[...visibleFiles]
            .sort(
              (a, b) =>
                Number(Boolean(b.is_dir)) - Number(Boolean(a.is_dir)) ||
                a.path.localeCompare(b.path),
            )
            .map((file) => (
              <div
                key={file.path}
                className="group flex items-center rounded hover:bg-accent"
              >
                <button
                  type="button"
                  aria-label={`${file.is_dir ? "Open folder" : "Preview"} ${basename(file.path)}`}
                  title={file.is_dir ? "Open folder" : "Preview in app"}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-2 text-left text-sm"
                  onClick={(event) => {
                    if (file.is_dir) setPath(file.path);
                    else {
                      openerRef.current = event.currentTarget;
                      setPreview(null);
                      setPreviewPath(file.path);
                    }
                  }}
                >
                  {file.is_dir ? (
                    <Folder size={15} className="shrink-0" />
                  ) : (
                    <File size={15} className="shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {basename(file.path)}
                  </span>
                  {file.is_dir ? (
                    <ChevronRight
                      size={14}
                      className="shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <Eye
                      size={14}
                      className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                      aria-hidden="true"
                    />
                  )}
                </button>
                {!file.is_dir && (
                  <button
                    type="button"
                    aria-label={`Download ${basename(file.path)}`}
                    className="p-2 text-muted-foreground"
                    onClick={() => download(file.path)}
                  >
                    <Download size={14} />
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
      <FilePreviewDialog
        open={Boolean(previewPath)}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewPath(undefined);
            setPreview(null);
          }
        }}
        onCloseAutoFocus={(event) => {
          if (openerRef.current?.isConnected) {
            event.preventDefault();
            openerRef.current.focus();
          }
        }}
        path={previewPath ?? ""}
        description={
          previewPath ? `${sourceLabel} · ${previewPath}` : sourceLabel
        }
        loading={!visiblePreview || visiblePreview.status === "loading"}
        source={
          visiblePreview?.status === "ready" ? visiblePreview.source : undefined
        }
        error={
          visiblePreview?.status === "error" ? visiblePreview.error : undefined
        }
        onRetry={() => setPreviewRevision((value) => value + 1)}
        onDownload={previewPath ? () => download(previewPath, true) : undefined}
      />
    </section>
  );
}
