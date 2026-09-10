import FileViewer, {
  type ViewerOptions,
  type ViewerState,
} from "@file-viewer/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { setDefaultFileViewerAssetBaseUrl } from "@file-viewer/core";
import type {
  FileViewerRendererPlugin,
  FileRenderHandler,
  FileViewerRenderedInstance,
} from "@file-viewer/core";
import { previewFamily } from "./index";
import {
  previewChromeStyles,
  readHostPreviewTheme,
  subscribeHostPreviewTheme,
} from "./theme";
import "./viewer.css";

function EnginePreview({
  file,
  options,
}: {
  file: File;
  options: ViewerOptions;
}) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useSyncExternalStore(
    subscribeHostPreviewTheme,
    readHostPreviewTheme,
    () => "light" as const,
  );
  const themedOptions = useMemo<ViewerOptions>(
    () => ({
      ...options,
      theme,
      toolbar: {
        ...(typeof options.toolbar === "object" ? options.toolbar : {}),
        theme: false,
        print: false,
        download: false,
        exportHtml: false,
      },
      ui: { ...options.ui, surfaceBackground: "var(--background, Canvas)" },
    }),
    [options, theme],
  );
  useEffect(() => {
    const boundary = host.current?.firstElementChild?.shadowRoot;
    if (!boundary) return;
    const style = document.createElement("style");
    style.dataset.sourceweftPreviewTheme = "true";
    style.textContent = previewChromeStyles;
    boundary.appendChild(style);
    return () => style.remove();
  }, []);
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    timer.current = setTimeout(
      () =>
        setError(
          "File preview timed out. Close it and try again, or download the file.",
        ),
      30000,
    );
    return () => clearTimeout(timer.current);
  }, []);
  const onStateChange = useCallback((state: ViewerState) => {
    if (state.ready || state.error) clearTimeout(timer.current);
    if (state.error)
      setError(
        state.error instanceof Error
          ? state.error.message
          : "Could not render this file. It may be damaged or unsupported.",
      );
  }, []);
  if (error)
    return (
      <p role="alert" style={{ padding: 24 }}>
        {error}
      </p>
    );
  return (
    <div
      ref={host}
      style={{ height: "100%", minHeight: 0, minWidth: 0, width: "100%" }}
    >
      <FileViewer
        className="sourceweft-file-viewer"
        file={file}
        options={themedOptions}
        onStateChange={onStateChange}
        style={{ height: "100%", width: "100%" }}
      />
    </div>
  );
}

export async function createPreviewView(name: string) {
  setDefaultFileViewerAssetBaseUrl("/file-viewer/");
  const family = previewFamily(name);
  const options = {
    rendererMode: "replace" as const,
    autoRenderers: false,
    styleIsolation: "shadow" as const,
    toolbar: { position: "top" as const },
  };
  if (family === "lite") {
    const { default: preset } = await import("@file-viewer/preset-lite");
    return function LightweightPreview({ file }: { file: File }) {
      return <EnginePreview file={file} options={{ ...options, preset }} />;
    };
  }
  const renderer: FileViewerRendererPlugin<
    FileRenderHandler<FileViewerRenderedInstance, HTMLDivElement>
  > =
    family === "pdf"
      ? (await import("@file-viewer/renderer-pdf")).default
      : family === "word"
        ? (await import("@file-viewer/renderer-word")).default
        : family === "spreadsheet"
          ? (await import("@file-viewer/renderer-spreadsheet")).default
          : family === "presentation"
            ? (await import("@file-viewer/renderer-pptx")).pptxRenderer
            : family === "legacyPresentation"
              ? (await import("@file-viewer/renderer-ppt")).pptRenderer
              : (await import("@file-viewer/renderer-epub")).default;
  return function DocumentPreview({ file }: { file: File }) {
    // Upstream's public type uses HTMLElement while its React host and official
    // renderer handlers use HTMLDivElement. This adapter owns that boundary.
    return (
      <EnginePreview
        file={file}
        options={{
          ...options,
          renderers: [renderer] as unknown as ViewerOptions["renderers"],
          ...(family === "legacyPresentation"
            ? {
                presentation: {
                  pptModuleUrl: "/file-viewer/vendor/ppt/index.mjs",
                  pptWorkerUrl: "/file-viewer/vendor/ppt/worker.mjs",
                  pptWasmUrl: "/file-viewer/vendor/ppt/ppt-native.wasm",
                  pptFontUrl: "/file-viewer/vendor/ppt/ppt-font-cjk.otf",
                  pptWorker: true,
                  // Private file previews should not persist rendered pages in IndexedDB.
                  pptCache: false,
                },
              }
            : {}),
        }}
      />
    );
  };
}
