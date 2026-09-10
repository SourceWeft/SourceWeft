"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  MAX_PREVIEW_BYTES,
  previewFamily,
  previewFileName,
  readPreviewBlob,
  type PreviewSource,
} from "./index";

export type PreviewProps = {
  source: PreviewSource;
  className?: string;
  onDownload?: () => void;
};

/** Import the DOM engine only after mounting, including in Next.js SSR. */
export function Preview({
  source: input,
  className,
  onDownload,
}: PreviewProps) {
  const source = useMemo(
    () => input,
    [input.name, input.mimeType, input.url, input.blob, input.text],
  );
  const [state, setState] = useState<{
    source: PreviewSource;
    View?: ComponentType<{ file: File }>;
    file?: File;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    const run = async () => {
      try {
        const blob =
          source.blob ??
          (source.text !== undefined
            ? new Blob([source.text], { type: source.mimeType ?? "text/plain" })
            : await readPreviewBlob(
                await fetch(source.url!, {
                  signal: controller.signal,
                  credentials: "same-origin",
                }),
                controller.signal,
              ));
        if (blob.size > MAX_PREVIEW_BYTES)
          throw new Error(
            "This file exceeds the 32 MB preview limit. Download it to open it.",
          );
        if (!blob.size) throw new Error("This file is empty.");
        const name = previewFileName(source.name, source.mimeType || blob.type);
        if (!previewFamily(name))
          throw new Error(
            "Preview is not available for this file type. Download it to open it.",
          );
        const file = new File([blob], name, {
          type: source.mimeType || blob.type,
        });
        const { createPreviewView } = await import("./viewer");
        const View = await createPreviewView(name);
        if (!controller.signal.aborted) setState({ source, View, file });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            source,
            error:
              error instanceof Error
                ? error.message
                : "Could not preview this file.",
          });
      }
    };
    void run();
    return () => controller.abort();
  }, [source]);
  const current = state?.source === source ? state : undefined;
  const View = current?.View;
  return (
    <section
      className={className}
      aria-label="File preview"
      style={{ height: "100%", minHeight: 0, minWidth: 0, width: "100%" }}
    >
      {current?.error ? (
        <div role="alert" style={{ padding: 24 }}>
          <p>{current.error}</p>
          {onDownload && (
            <button type="button" onClick={onDownload}>
              Download file
            </button>
          )}
        </div>
      ) : View && current?.file ? (
        <View file={current.file} />
      ) : (
        <p role="status" style={{ padding: 24 }}>
          Loading file preview…
        </p>
      )}
    </section>
  );
}
