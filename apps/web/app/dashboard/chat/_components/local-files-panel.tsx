"use client";

import { useEffect, useRef, useState } from "react";
import { File, Folder, ArrowUp, RefreshCw, Download, X } from "lucide-react";
import { localRequest } from "../../../../lib/local-execution";
import { downloadLocalFile } from "../../../../lib/local-file-download";

type Directory = {
  root: string;
  path: string;
  files: Array<{ path: string; is_dir?: boolean; size?: number }>;
};

/** Every refresh reads the bound PC. A failed request removes stale disk content. */
export function LocalFilesPanel({
  workspaceId,
  threadId,
  onClose,
  variant = "panel",
  computerName,
  searchQuery = "",
}: {
  workspaceId: string;
  threadId: string;
  onClose?: () => void;
  variant?: "panel" | "hub";
  computerName?: string;
  searchQuery?: string;
}) {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [path, setPath] = useState<string>();
  const [previewPath, setPreviewPath] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const [previewError, setPreviewError] = useState<string>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/local-files`;
  useEffect(() => {
    let live = true;
    let busy = false;
    setDirectory(null);
    setPreview(undefined);
    setError(undefined);
    setPreviewError(undefined);
    setLoading(true);
    const refresh = async () => {
      if (busy) return;
      busy = true;
      const current = ++sequence.current;
      try {
        const result = await localRequest<Directory>(
          `${base}${path ? `?path=${encodeURIComponent(path)}` : ""}`,
        );
        let text: { content: string } | null = null;
        let previewFailure: string | undefined;
        if (previewPath) {
          try {
            text = await localRequest<{ content: string }>(
              `${base}?path=${encodeURIComponent(previewPath)}&content=true`,
            );
          } catch (cause) {
            if ((cause as { status?: number }).status === 415)
              previewFailure =
                "This file cannot be previewed as text. Download it to open it.";
            else throw cause;
          }
        }
        if (live && current === sequence.current) {
          setDirectory(result);
          setPreview(text?.content);
          setPreviewError(previewFailure);
          setError(undefined);
        }
      } catch (cause) {
        if (live && current === sequence.current) {
          setDirectory(null);
          setPreview(undefined);
          setError(cause instanceof Error ? cause.message : String(cause));
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
  }, [base, path, previewPath, revision]);
  const visibleFiles =
    directory?.files.filter(
      (file) =>
        !searchQuery.trim() ||
        file.path.toLowerCase().includes(searchQuery.trim().toLowerCase()),
    ) ?? [];
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
        {previewPath && (
          <button
            type="button"
            className="text-xs underline"
            onClick={() => setPreviewPath(undefined)}
          >
            Back to files
          </button>
        )}
        <span className="text-xs text-muted-foreground">
          {computerName
            ? `This computer · ${computerName}`
            : "Stored on this computer"}
        </span>
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
            onClick={() => {
              setPath(directory.path.slice(0, directory.path.lastIndexOf("/")));
              setPreviewPath(undefined);
            }}
            className="rounded p-1 disabled:opacity-30"
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
        <div
          className={
            variant === "hub"
              ? "flex min-h-0 flex-col overflow-auto"
              : "flex min-h-0 overflow-auto"
          }
        >
          <div className="min-w-56 flex-1 p-2">
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
                  className="flex items-center rounded hover:bg-accent"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                    onClick={() => {
                      if (file.is_dir) {
                        setPath(file.path);
                        setPreviewPath(undefined);
                      } else setPreviewPath(file.path);
                    }}
                  >
                    {file.is_dir ? <Folder size={15} /> : <File size={15} />}
                    <span className="truncate">
                      {file.path.split("/").pop()}
                    </span>
                  </button>
                  {!file.is_dir && (
                    <button
                      type="button"
                      aria-label={`Download ${file.path.split("/").pop()}`}
                      className="p-2 text-muted-foreground"
                      onClick={() =>
                        void downloadLocalFile(
                          `${base}?path=${encodeURIComponent(file.path)}&download=true`,
                          file.path.split("/").pop() ?? "file",
                        ).catch((cause) =>
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : String(cause),
                          ),
                        )
                      }
                    >
                      <Download size={14} />
                    </button>
                  )}
                </div>
              ))}
          </div>
          {(preview !== undefined || previewError) && (
            <div
              className={
                variant === "hub"
                  ? "min-w-0 overflow-auto border-t p-3"
                  : "min-w-0 flex-[2] overflow-auto border-l p-3"
              }
            >
              <p className="mb-2 break-all text-xs text-muted-foreground">
                {previewPath}
              </p>
              {previewError ? (
                <p className="text-sm text-muted-foreground">{previewError}</p>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {preview}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
