import FileViewer, {
  type ViewerOptions,
  type ViewerState,
  type FileViewerHandle,
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
import { previewFamily, type PreviewLocation } from "./index";
import {
  previewChromeStyles,
  readHostPreviewTheme,
  subscribeHostPreviewTheme,
} from "./theme";
import "./viewer.css";

function EnginePreview({
  file,
  options,
  location,
}: {
  file: File;
  options: ViewerOptions;
  location?: PreviewLocation;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<FileViewerHandle>(null);
  const positioned = useRef(false);
  const [locationMessage, setLocationMessage] = useState<string>();
  useEffect(() => {
    positioned.current = false;
    setLocationMessage(undefined);
  }, [file, location]);
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
  const onStateChange = useCallback(
    (state: ViewerState) => {
      if (state.ready || state.error) clearTimeout(timer.current);
      if (state.error)
        setError(
          state.error instanceof Error
            ? state.error.message
            : "Could not render this file. It may be damaged or unsupported.",
        );
      if (state.ready && location && viewer.current && !positioned.current) {
        positioned.current = true;
        const controller = viewer.current;
        void (async () => {
          if (location.page)
            return (
              (await controller.applyViewState({ page: location.page }))
                ?.page === location.page
            );
          if (location.line) return controller.scrollToLine(location.line);
          if (location.quote) {
            const normalize = (value: string) =>
              value.replace(/\s+/g, " ").trim();
            const quote = normalize(location.quote).slice(0, 160);
            const matches = quote
              ? controller
                  .getDocumentTextChunks()
                  .filter((chunk) => normalize(chunk.text).includes(quote))
              : [];
            if (matches.length === 1)
              return controller.scrollToAnchor(matches[0]!.anchor);
          }
          return false;
        })()
          .then((located) => {
            if (!located)
              setLocationMessage(
                "Automatic positioning is unavailable for this location. Refer to the cited excerpt and location label.",
              );
          })
          .catch(() =>
            setLocationMessage(
              "Could not position this location. Refer to the cited excerpt and location label.",
            ),
          );
      }
    },
    [location],
  );
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
        ref={viewer}
        className="sourceweft-file-viewer"
        file={file}
        options={themedOptions}
        onStateChange={onStateChange}
        style={{ height: "100%", width: "100%" }}
      />
      {locationMessage && (
        <p role="status" style={{ padding: 8, fontSize: 12 }}>
          {locationMessage}
        </p>
      )}
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
    return function LightweightPreview({
      file,
      location,
    }: {
      file: File;
      location?: PreviewLocation;
    }) {
      return (
        <EnginePreview
          file={file}
          location={location}
          options={{ ...options, preset }}
        />
      );
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
  return function DocumentPreview({
    file,
    location,
  }: {
    file: File;
    location?: PreviewLocation;
  }) {
    // Upstream's public type uses HTMLElement while its React host and official
    // renderer handlers use HTMLDivElement. This adapter owns that boundary.
    return (
      <EnginePreview
        file={file}
        location={location}
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
