"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileCode2,
  FileType2,
  Loader2,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { Player } from "@remotion/player";
import { toast } from "sonner";
import { GeneratedImagePreview } from "../chat-canvas/generated-image-preview";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { apiBaseUrl } from "../../../../../lib/sdk";
import {
  artifactTitle,
  artifactTypeLabel,
  resolveArtifactDownloadUrl,
  resolveArtifactPageUrl,
  resolveArtifactProxyFileUrl,
} from "./artifacts";
import { TypeBadge } from "./type-badge";
import type { ArtifactListItem } from "./types";
import { stripExecutableVisualDeckHtmlForExport } from "./visual-deck-export-html";
import {
  getVideoDurationInFrames,
  getVideoDurationSeconds,
  useVideoPresentationSpec,
  VIDEO_PRESENTATION_AUDIO_DELAY_RENDER_TIMEOUT_MS,
  VideoPresentationComposition,
  type RenderableVideoPresentationSpec,
} from "./video-presentation-renderer";

type SlidesGenerationMode = "visual_html" | "editable_native";
const VISUAL_DECK_CONTROLS_HEIGHT = 48;
const VISUAL_DECK_RASTER_CONCURRENCY = 2;
const VIDEO_EXPORT_BITRATE = 5_000_000;
const VIDEO_EXPORT_FPS = 24;
const VIDEO_EXPORT_MAX_WIDTH = 1280;
const VIDEO_EXPORT_SECONDS_PER_SLIDE = 2;
const VIDEO_EXPORT_TRANSITION_SECONDS = 0.3;

type VisualDeckFontMetadata = {
  body?: VisualDeckFontReference;
  fonts?: VisualDeckFontReference[];
  heading?: VisualDeckFontReference;
};

type VisualDeckFontReference = {
  cssFamily?: string;
  embedUrl?: string;
  family?: string;
  key?: string;
  roles?: string[];
  weights?: number[];
};

type ArtifactPreviewLayout = "page" | "panel";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function payloadRecord(artifact: ArtifactListItem) {
  const payload = artifact.payloadJson;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveSlidesGenerationMode(
  artifact: ArtifactListItem,
): SlidesGenerationMode {
  const payload = payloadRecord(artifact);
  const generationMode = payloadString(payload, "generationMode");
  if (generationMode === "editable_native") {
    return "editable_native";
  }
  if (generationMode === "visual_html") {
    return "visual_html";
  }
  const previewRenderer = payloadString(payload, "previewRenderer");
  if (previewRenderer === "pptxviewjs") {
    return "editable_native";
  }
  if (previewRenderer === "html_iframe") {
    return "visual_html";
  }
  const mimeType = payloadString(payload, "mimeType");
  return mimeType?.startsWith("text/html") ? "visual_html" : "editable_native";
}

function resolveSlidesAspectRatio(artifact: ArtifactListItem) {
  const payload = payloadRecord(artifact);
  return payloadString(payload, "aspectRatio") ?? "16:9";
}

function resolveSlidesCount(artifact: ArtifactListItem) {
  const payload = payloadRecord(artifact);
  const value = payload.slideCount;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function isVideoArtifact(artifact: ArtifactListItem) {
  const payload = payloadRecord(artifact);
  return (
    artifact.artifactType === "video_overview" ||
    payloadString(payload, "artifactKind") === "video_presentation" ||
    payloadString(payload, "mimeType")?.startsWith("video/") === true
  );
}

function resolveVideoProjectStageLabel(payload: Record<string, unknown>) {
  const generation =
    payload.generation &&
    typeof payload.generation === "object" &&
    !Array.isArray(payload.generation)
      ? (payload.generation as Record<string, unknown>)
      : null;
  const stage = typeof generation?.stage === "string" ? generation.stage : null;
  if (stage === "failed") {
    return "Video project failed";
  }
  if (stage === "planning") {
    return "Planning video scenes";
  }
  if (stage === "generating_audio") {
    return "Generating narration audio";
  }
  if (stage === "finalizing_project") {
    return "Finalizing video project";
  }
  return "Preparing video project";
}

function numericAspectRatio(aspectRatio: string | null) {
  if (aspectRatio === "4:3") {
    return 4 / 3;
  }
  if (aspectRatio === "16:10") {
    return 16 / 10;
  }
  return 16 / 9;
}

function slideLayoutForAspectRatio(aspectRatio: string | null) {
  if (aspectRatio === "4:3") {
    return { height: 7.5, layout: "LAYOUT_4x3", width: 10 };
  }
  if (aspectRatio === "16:10") {
    return { height: 6.25, layout: "LAYOUT_16x10", width: 10 };
  }
  return { height: 7.5, layout: "LAYOUT_WIDE", width: 13.333 };
}

function slidePixelSizeForAspectRatio(aspectRatio: string | null) {
  if (aspectRatio === "4:3") {
    return { height: 1080, width: 1440 };
  }
  if (aspectRatio === "16:10") {
    return { height: 1200, width: 1920 };
  }
  return { height: 1080, width: 1920 };
}

function parsePositiveNumber(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value.replace("px", ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveDeckExportDimensions(
  doc: Document,
  aspectRatio: string | null,
) {
  const shell = doc.querySelector<HTMLElement>(".deck-shell");
  const rootStyle = doc.defaultView?.getComputedStyle(doc.documentElement);
  const fallback = slidePixelSizeForAspectRatio(aspectRatio);
  return {
    height:
      parsePositiveNumber(shell?.dataset.slideHeight) ??
      parsePositiveNumber(rootStyle?.getPropertyValue("--slide-h")) ??
      fallback.height,
    width:
      parsePositiveNumber(shell?.dataset.slideWidth) ??
      parsePositiveNumber(rootStyle?.getPropertyValue("--slide-w")) ??
      fallback.width,
  };
}

function suggestedExportName(title: string, extension: string) {
  const compact = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${compact || "presentation"}.${extension}`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function visualDeckExportError(stage: string, error: unknown) {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "Unexpected export error.";
  return new Error(`Visual deck export failed during ${stage}: ${message}`);
}

async function waitForIframeDocument(
  iframe: HTMLIFrameElement,
  stage = "load_html",
  options: { allowAlreadyLoaded?: boolean } = {},
) {
  const existingDoc = iframe.contentDocument;
  if (
    options.allowAlreadyLoaded !== false &&
    existingDoc?.readyState === "complete"
  ) {
    return existingDoc;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`Timed out while preparing deck export (${stage}).`));
    }, 12_000);
    iframe.addEventListener(
      "load",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

  const doc = iframe.contentDocument;
  if (!doc) {
    throw new Error(`Unable to access deck export frame (${stage}).`);
  }
  return doc;
}

function parseVisualDeckFontMetadata(doc: Document): VisualDeckFontMetadata {
  const raw = doc.documentElement.dataset.sourceweftFonts;
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as VisualDeckFontMetadata)
      : {};
  } catch {
    return {};
  }
}

function uniqueVisualDeckFontReferences(
  metadata: VisualDeckFontMetadata,
): VisualDeckFontReference[] {
  const fontMap = new Map<string, VisualDeckFontReference>();
  const fontReferences: VisualDeckFontReference[] = [
    ...(metadata.fonts ?? []),
    ...(metadata.body ? [metadata.body] : []),
    ...(metadata.heading ? [metadata.heading] : []),
  ];
  for (const font of fontReferences) {
    const family = font?.cssFamily ?? font?.family;
    if (!family) {
      continue;
    }
    fontMap.set(family, font);
  }
  return Array.from(fontMap.values());
}

function resolveVisualDeckPptxFonts(doc: Document) {
  return uniqueVisualDeckFontReferences(parseVisualDeckFontMetadata(doc))
    .map((font) => {
      const name = font.family ?? font.cssFamily;
      const url = font.embedUrl;
      return name && url ? { name, url } : null;
    })
    .filter((font): font is { name: string; url: string } => Boolean(font));
}

async function waitForVisualDeckFonts(doc: Document) {
  const fontSet = doc.fonts;
  if (!fontSet) {
    return;
  }
  const fonts = uniqueVisualDeckFontReferences(
    parseVisualDeckFontMetadata(doc),
  );
  await fontSet.ready;
  await Promise.all(
    fonts.flatMap((font) => {
      const family = font.cssFamily ?? font.family;
      if (!family) {
        return [];
      }
      const weights = font.weights?.length ? font.weights : [400, 700];
      return weights.map((weight) => fontSet.load(`${weight} 16px ${family}`));
    }),
  );
  await fontSet.ready;
  const unloadedFont = fonts.find((font) => {
    const family = font.cssFamily ?? font.family;
    return family ? !fontSet.check(`400 16px ${family}`) : false;
  });
  if (unloadedFont) {
    throw new Error(
      `Could not load the deck font "${unloadedFont.family ?? unloadedFont.cssFamily}".`,
    );
  }
}

async function waitForExportLayout() {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 80));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );
  return results;
}

type PreparedVisualDeckExport = {
  aspectRatio: string;
  dimensions: {
    height: number;
    width: number;
  };
  dispose: () => void;
  doc: Document;
  iframe: HTMLIFrameElement;
  slideElements: HTMLElement[];
};

async function prepareVisualDeckExport(fileUrl: string) {
  const response = await fetch(fileUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error("Could not load the HTML deck for export.");
  }
  const html = await response.text();
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.top = "0";
  iframe.style.width = "1px";
  iframe.style.height = "1px";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);

  try {
    const loaded = waitForIframeDocument(iframe, "load_html", {
      allowAlreadyLoaded: false,
    });
    iframe.srcdoc = stripExecutableVisualDeckHtmlForExport(html);
    const doc = await loaded;
    await waitForVisualDeckExportFrame(doc);
    const shell = doc.querySelector<HTMLElement>(".deck-shell");
    const aspectRatio =
      shell?.dataset.aspectRatio ??
      doc.documentElement.dataset.sourceweftAspect ??
      "16:9";
    const dimensions = resolveDeckExportDimensions(doc, aspectRatio);
    iframe.style.width = `${dimensions.width}px`;
    iframe.style.height = `${dimensions.height}px`;
    doc.documentElement.style.width = `${dimensions.width}px`;
    doc.body.style.width = `${dimensions.width}px`;
    doc.body.style.minHeight = `${dimensions.height}px`;
    const slideElements = Array.from(
      doc.querySelectorAll<HTMLElement>(".sw-slide"),
    );
    if (slideElements.length === 0) {
      throw new Error("No slides were found in this deck.");
    }
    for (const slideElement of slideElements) {
      slideElement.style.width = `${dimensions.width}px`;
      slideElement.style.height = `${dimensions.height}px`;
    }
    await waitForExportLayout();
    return {
      aspectRatio,
      dimensions,
      dispose: () => iframe.remove(),
      doc,
      iframe,
      slideElements,
    } satisfies PreparedVisualDeckExport;
  } catch (error) {
    iframe.remove();
    throw error;
  }
}

function createVisualDeckImageFromUrl(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const decoded = image.decode?.();
      if (decoded) {
        void decoded.finally(() => resolve(image));
        return;
      }
      resolve(image);
    };
    image.onerror = () => reject(new Error("Could not render this slide."));
    image.src = url;
  });
}

async function waitForVisualDeckExportFrame(doc: Document) {
  try {
    await doc.fonts?.ready;
    await waitForVisualDeckFonts(doc);
  } catch (error) {
    throw visualDeckExportError("load_fonts", error);
  }
  await Promise.all(
    Array.from(doc.images).map((image) =>
      image.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            image.onload = () => resolve();
            image.onerror = () => resolve();
          }),
    ),
  );
  await waitForExportLayout();
}

function cloneVisualDeckStyles(sourceDoc: Document, targetDoc: Document) {
  for (const node of Array.from(sourceDoc.head.children)) {
    const tagName = node.tagName.toLowerCase();
    if (tagName === "style" || tagName === "meta") {
      targetDoc.head.append(targetDoc.importNode(node, true));
    }
  }
}

function appendVisualDeckFontEmbedCss(doc: Document, fontEmbedCSS: string) {
  if (!fontEmbedCSS.trim()) {
    return;
  }
  const style = doc.createElement("style");
  style.dataset.sourceweftExportFonts = "true";
  style.textContent = fontEmbedCSS;
  doc.head.append(style);
}

async function inlineVisualDeckImageElements(doc: Document) {
  await Promise.all(
    Array.from(doc.images).map(async (image) => {
      if (!image.src || image.src.startsWith("data:")) {
        return;
      }
      try {
        const response = await fetch(image.src, { credentials: "include" });
        if (!response.ok) {
          return;
        }
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            typeof reader.result === "string"
              ? resolve(reader.result)
              : reject(new Error("Could not inline a deck image."));
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        image.removeAttribute("srcset");
        image.src = dataUrl;
      } catch {
        // Best effort: keep the original source when a browser blocks inlining.
      }
    }),
  );
}

function visualDeckDocumentToSvgDataUrl(
  doc: Document,
  dimensions: {
    height: number;
    width: number;
  },
) {
  const xmlns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(xmlns, "svg");
  const foreignObject = document.createElementNS(xmlns, "foreignObject");
  svg.setAttribute("xmlns", xmlns);
  svg.setAttribute("width", `${dimensions.width}`);
  svg.setAttribute("height", `${dimensions.height}`);
  svg.setAttribute("viewBox", `0 0 ${dimensions.width} ${dimensions.height}`);
  foreignObject.setAttribute("x", "0");
  foreignObject.setAttribute("y", "0");
  foreignObject.setAttribute("width", "100%");
  foreignObject.setAttribute("height", "100%");
  const html = document.importNode(doc.documentElement, true);
  html.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  foreignObject.append(html);
  svg.append(foreignObject);
  const serialized = new XMLSerializer().serializeToString(svg);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
}

function buildVisualDeckSingleSlideDocument(input: {
  deck: PreparedVisualDeckExport;
  slideIndex: number;
}) {
  const { deck, slideIndex } = input;
  const doc = document.implementation.createHTMLDocument(
    deck.doc.title || "Visual deck export",
  );
  doc.documentElement.lang = deck.doc.documentElement.lang;
  for (const attribute of Array.from(deck.doc.documentElement.attributes)) {
    doc.documentElement.setAttribute(attribute.name, attribute.value);
  }
  cloneVisualDeckStyles(deck.doc, doc);
  const style = doc.createElement("style");
  style.textContent = `
html,
body {
  width: ${deck.dimensions.width}px !important;
  height: ${deck.dimensions.height}px !important;
  min-height: ${deck.dimensions.height}px !important;
  margin: 0 !important;
  overflow: hidden !important;
  background: transparent !important;
}
.deck-viewport {
  position: static !important;
  display: block !important;
  width: ${deck.dimensions.width}px !important;
  height: ${deck.dimensions.height}px !important;
  min-height: ${deck.dimensions.height}px !important;
  padding: 0 !important;
  overflow: hidden !important;
  background: transparent !important;
}
.deck-shell {
  position: static !important;
  width: ${deck.dimensions.width}px !important;
  height: ${deck.dimensions.height}px !important;
  transform: none !important;
  transform-origin: top left !important;
}
.sw-slide {
  position: absolute !important;
  inset: 0 !important;
  width: ${deck.dimensions.width}px !important;
  height: ${deck.dimensions.height}px !important;
  margin: 0 !important;
  visibility: hidden !important;
  opacity: 0 !important;
  transform: none !important;
  transition: none !important;
}
.sw-slide[data-sourceweft-export-active="true"] {
  visibility: visible !important;
  opacity: 1 !important;
}
[data-anim],
.chart-fill {
  opacity: 1 !important;
  transform: none !important;
  animation: none !important;
  transition: none !important;
}
.deck-controls,
.sourceweft-preview-controls {
  display: none !important;
}
`;
  doc.head.append(style);
  const viewport = doc.createElement("main");
  viewport.className = "deck-viewport";
  const shell = doc.createElement("div");
  shell.className = "deck-shell";
  shell.dataset.slideWidth = String(deck.dimensions.width);
  shell.dataset.slideHeight = String(deck.dimensions.height);
  shell.dataset.aspectRatio = deck.aspectRatio;
  const sourceSlide = deck.slideElements[slideIndex];
  if (!sourceSlide) {
    throw new Error("Could not prepare this slide for export.");
  }
  const slide = doc.importNode(sourceSlide, true);
  if (slide.nodeType !== Node.ELEMENT_NODE) {
    throw new Error("Could not prepare this slide for export.");
  }
  const slideElement = slide as HTMLElement;
  slideElement.classList.add("is-active");
  slideElement.dataset.sourceweftExportActive = "true";
  slideElement.style.width = `${deck.dimensions.width}px`;
  slideElement.style.height = `${deck.dimensions.height}px`;
  shell.append(slideElement);
  viewport.append(shell);
  doc.body.append(viewport);
  return doc;
}

async function renderVisualDeckSlideToCanvas(input: {
  deck: PreparedVisualDeckExport;
  fontEmbedCSS: string;
  pixelRatio: number;
  slideIndex: number;
}) {
  const { deck, fontEmbedCSS, pixelRatio, slideIndex } = input;
  const exportDoc = buildVisualDeckSingleSlideDocument({ deck, slideIndex });
  appendVisualDeckFontEmbedCss(exportDoc, fontEmbedCSS);
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.left = "-10000px";
  frame.style.top = "0";
  frame.style.width = `${deck.dimensions.width}px`;
  frame.style.height = `${deck.dimensions.height}px`;
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.setAttribute("aria-hidden", "true");
  document.body.append(frame);
  try {
    const loaded = waitForIframeDocument(frame, "load_html", {
      allowAlreadyLoaded: false,
    });
    frame.srcdoc = stripExecutableVisualDeckHtmlForExport(
      `<!doctype html>${exportDoc.documentElement.outerHTML}`,
    );
    const doc = await loaded;
    try {
      await inlineVisualDeckImageElements(doc);
    } catch (error) {
      throw visualDeckExportError("inline_images", error);
    }
    await waitForVisualDeckExportFrame(doc);
    const image = await createVisualDeckImageFromUrl(
      (() => {
        try {
          return visualDeckDocumentToSvgDataUrl(doc, deck.dimensions);
        } catch (error) {
          throw visualDeckExportError("render_svg", error);
        }
      })(),
    ).catch((error: unknown) => {
      throw visualDeckExportError("render_svg", error);
    });
    const canvas = document.createElement("canvas");
    const ratio = Math.max(1, pixelRatio);
    canvas.width = Math.round(deck.dimensions.width * ratio);
    canvas.height = Math.round(deck.dimensions.height * ratio);
    canvas.style.width = `${deck.dimensions.width}px`;
    canvas.style.height = `${deck.dimensions.height}px`;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a slide export canvas.");
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    frame.remove();
  }
}

async function rasterizeVisualDeckSlides(
  deck: PreparedVisualDeckExport,
  pixelRatio: number,
) {
  const htmlToImage = await import("html-to-image");
  const fontEmbedCSS = await htmlToImage.getFontEmbedCSS(deck.doc.body, {
    preferredFontFormat: "woff2",
  });
  return mapWithConcurrency(
    deck.slideElements,
    VISUAL_DECK_RASTER_CONCURRENCY,
    async (_slideElement, slideIndex) =>
      renderVisualDeckSlideToCanvas({
        deck,
        fontEmbedCSS,
        pixelRatio,
        slideIndex,
      }).then((canvas) => canvas.toDataURL("image/png")),
  );
}

async function rasterizeVisualDeckCanvases(
  deck: PreparedVisualDeckExport,
  pixelRatio: number,
) {
  const htmlToImage = await import("html-to-image");
  const fontEmbedCSS = await htmlToImage.getFontEmbedCSS(deck.doc.body, {
    preferredFontFormat: "woff2",
  });
  return mapWithConcurrency(
    deck.slideElements,
    VISUAL_DECK_RASTER_CONCURRENCY,
    async (_slideElement, slideIndex) =>
      renderVisualDeckSlideToCanvas({
        deck,
        fontEmbedCSS,
        pixelRatio,
        slideIndex,
      }),
  );
}

type VideoExportFormat = {
  extension: "mp4" | "webm";
  label: string;
  mimeType: string;
};

type RemotionWebRenderFormat = {
  container: "mp4" | "webm";
  extension: "mp4" | "webm";
  label: string;
  videoCodec: "h264" | "h265" | "vp8" | "vp9";
};

type VideoPresentationAudioTrack = {
  assetUrl: string;
  fileName?: string;
  mimeType?: string;
  slideNumber: number;
};

function chooseVideoFormat(): VideoExportFormat | null {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }
  const candidates: VideoExportFormat[] = [
    {
      extension: "mp4",
      label: "MP4",
      mimeType: "video/mp4;codecs=avc1.42E01E",
    },
    {
      extension: "mp4",
      label: "MP4",
      mimeType: "video/mp4;codecs=h264",
    },
    {
      extension: "mp4",
      label: "MP4",
      mimeType: "video/mp4",
    },
    {
      extension: "webm",
      label: "WebM",
      mimeType: "video/webm;codecs=vp9",
    },
    {
      extension: "webm",
      label: "WebM",
      mimeType: "video/webm;codecs=vp8",
    },
    {
      extension: "webm",
      label: "WebM",
      mimeType: "video/webm",
    },
  ];
  return (
    candidates.find((format) =>
      MediaRecorder.isTypeSupported(format.mimeType),
    ) ?? null
  );
}

async function chooseRemotionWebRenderFormat(): Promise<RemotionWebRenderFormat | null> {
  const { canRenderMediaOnWeb } = await import("@remotion/web-renderer");
  const candidates: RemotionWebRenderFormat[] = [
    { container: "mp4", extension: "mp4", label: "MP4", videoCodec: "h264" },
    { container: "mp4", extension: "mp4", label: "MP4", videoCodec: "h265" },
    { container: "webm", extension: "webm", label: "WebM", videoCodec: "vp9" },
    { container: "webm", extension: "webm", label: "WebM", videoCodec: "vp8" },
  ];
  for (const candidate of candidates) {
    const result = await canRenderMediaOnWeb({
      container: candidate.container,
      videoCodec: candidate.videoCodec,
      height: 1080,
      width: 1920,
    });
    if (result.canRender) {
      return candidate;
    }
  }
  return null;
}

function easeInOut(value: number) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

async function waitForVideoFrame(frameMs: number) {
  await new Promise((resolve) => window.setTimeout(resolve, frameMs));
}

function resolveAssetFetchUrl(value: string) {
  return value.startsWith("/v1/") ? `${apiBaseUrl}${value}` : value;
}

async function prepareVideoAudio(input: {
  audioTracks: VideoPresentationAudioTrack[];
  secondsPerSlide: number;
}) {
  if (input.audioTracks.length === 0) {
    return null;
  }
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("Audio export requires a browser with Web Audio support.");
  }
  const context = new AudioContextClass();
  const destination = context.createMediaStreamDestination();
  const buffers = await Promise.all(
    input.audioTracks.map(async (track) => {
      const response = await fetch(resolveAssetFetchUrl(track.assetUrl), {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Could not load narration audio for video export.");
      }
      return {
        buffer: await context.decodeAudioData(await response.arrayBuffer()),
        startSeconds: Math.max(
          0,
          (track.slideNumber - 1) * input.secondsPerSlide,
        ),
      };
    }),
  );
  return { buffers, context, destination };
}

async function exportVisualDeckVideo(input: {
  audioTracks?: VideoPresentationAudioTrack[];
  fileUrl: string;
  fps?: number;
  narrationEnabled?: boolean;
  secondsPerSlide: number;
  title: string;
  transitionSeconds: number;
}) {
  const videoFormat = chooseVideoFormat();
  if (!videoFormat) {
    throw new Error(
      "Video export requires a browser with MediaRecorder MP4 or WebM support.",
    );
  }
  let deck: PreparedVisualDeckExport | null = null;
  let stream: MediaStream | null = null;
  let audio: Awaited<ReturnType<typeof prepareVideoAudio>> | null = null;
  const scheduledSources: AudioBufferSourceNode[] = [];
  try {
    deck = await prepareVisualDeckExport(input.fileUrl);
    const slideCanvases = await rasterizeVisualDeckCanvases(deck, 1);
    const canvas = document.createElement("canvas");
    const exportScale = Math.min(
      1,
      VIDEO_EXPORT_MAX_WIDTH / deck.dimensions.width,
    );
    canvas.width = Math.max(1, Math.round(deck.dimensions.width * exportScale));
    canvas.height = Math.max(
      1,
      Math.round(deck.dimensions.height * exportScale),
    );
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a video rendering canvas.");
    }
    const firstSlideCanvas = slideCanvases[0];
    if (!firstSlideCanvas) {
      throw new Error("No slides were rendered for video export.");
    }
    context.drawImage(firstSlideCanvas, 0, 0, canvas.width, canvas.height);

    if (input.narrationEnabled && input.audioTracks?.length) {
      audio = await prepareVideoAudio({
        audioTracks: input.audioTracks,
        secondsPerSlide: input.secondsPerSlide,
      });
      await audio?.context.resume();
    }

    const fps = input.fps ?? VIDEO_EXPORT_FPS;
    const frameMs = 1000 / fps;
    const slideFrames = Math.max(1, Math.round(fps * input.secondsPerSlide));
    const transitionFrames = Math.max(
      1,
      Math.round(fps * input.transitionSeconds),
    );
    const chunks: Blob[] = [];
    const videoStream = canvas.captureStream(fps);
    stream = audio
      ? new MediaStream([
          ...videoStream.getVideoTracks(),
          ...audio.destination.stream.getAudioTracks(),
        ])
      : videoStream;
    const recorder = new MediaRecorder(stream, {
      mimeType: videoFormat.mimeType,
      videoBitsPerSecond: VIDEO_EXPORT_BITRATE,
    });
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.addEventListener(
        "error",
        () => reject(new Error("Video export failed while recording.")),
        { once: true },
      );
    });

    if (audio) {
      const audioStartAt = audio.context.currentTime + 0.12;
      for (const item of audio.buffers) {
        const source = audio.context.createBufferSource();
        source.buffer = item.buffer;
        source.connect(audio.destination);
        source.start(audioStartAt + item.startSeconds);
        scheduledSources.push(source);
      }
    }

    recorder.start();
    if (audio) {
      await waitForVideoFrame(120);
    }
    const timelineSeconds = slideCanvases.length * input.secondsPerSlide;
    const audioEndSeconds = Math.max(
      0,
      ...(audio?.buffers.map(
        (item) => item.startSeconds + item.buffer.duration,
      ) ?? []),
    );
    for (const [index, slideCanvas] of slideCanvases.entries()) {
      for (let frame = 0; frame < slideFrames; frame += 1) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(slideCanvas, 0, 0, canvas.width, canvas.height);
        if (index > 0 && frame < transitionFrames) {
          const opacity = 1 - easeInOut(frame / transitionFrames);
          context.globalAlpha = opacity;
          context.drawImage(
            slideCanvases[index - 1] ?? slideCanvas,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          context.globalAlpha = 1;
        }
        await waitForVideoFrame(frameMs);
      }
    }
    const lastSlideCanvas = slideCanvases[slideCanvases.length - 1];
    if (lastSlideCanvas) {
      const tailFrames = Math.max(
        0,
        Math.ceil((audioEndSeconds - timelineSeconds) * fps),
      );
      for (let frame = 0; frame < tailFrames; frame += 1) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(lastSlideCanvas, 0, 0, canvas.width, canvas.height);
        await waitForVideoFrame(frameMs);
      }
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: videoFormat.mimeType });
    if (blob.size <= 0) {
      throw new Error("Video export produced an empty file.");
    }
    downloadBlob(blob, suggestedExportName(input.title, videoFormat.extension));
    toast.success(`${videoFormat.label} export started.`);
  } finally {
    for (const source of scheduledSources) {
      try {
        source.stop();
      } catch {
        // Audio sources may already have ended naturally.
      }
    }
    await audio?.context.close().catch(() => undefined);
    stream?.getTracks().forEach((track) => track.stop());
    deck?.dispose();
  }
}

function SlidesFallback({
  detail,
  title,
}: {
  detail?: string;
  title?: string;
}) {
  return (
    <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed bg-background/70 px-5 text-center">
      <div>
        <Sparkles className="mx-auto mb-3 size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {title ?? "PPTX artifact is ready"}
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {detail ??
            "Open it in a new tab or download the artifact from the toolbar."}
        </p>
      </div>
    </div>
  );
}

function VideoArtifactPreview({
  fileUrl,
  title,
}: {
  fileUrl: string;
  title: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Video className="size-3.5 text-muted-foreground" />
        <p className="truncate text-xs font-medium text-foreground">
          Video Preview
        </p>
      </div>
      <div className="bg-[#0b1017] p-2">
        <video
          className="mx-auto max-h-[calc(100vh-12rem)] w-full rounded-lg bg-black"
          controls
          playsInline
          preload="metadata"
          src={fileUrl}
          title={title}
        />
      </div>
    </div>
  );
}

function VisualHtmlDeckPreview({
  aspectRatio,
  previewUrl,
  title,
}: {
  aspectRatio: string | null;
  previewUrl: string;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingEditable, setExportingEditable] = useState(false);
  const [exportingVideo, setExportingVideo] = useState(false);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const [isFrameLoading, setIsFrameLoading] = useState(true);
  const isExportingAny =
    exporting || exportingEditable || exportingHtml || exportingVideo;

  useEffect(() => {
    setIsFrameLoading(true);
  }, [previewUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleResize = () => {
      const width = container.clientWidth;
      if (width > 0) {
        setFrameHeight(
          Math.round(
            width / numericAspectRatio(aspectRatio) +
              VISUAL_DECK_CONTROLS_HEIGHT,
          ),
        );
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(container);
    handleResize();
    return () => {
      observer.disconnect();
    };
  }, [aspectRatio]);

  const handleExportPptx = useCallback(async () => {
    setExporting(true);
    let deck: PreparedVisualDeckExport | null = null;
    try {
      deck = await prepareVisualDeckExport(previewUrl);
      const { height, layout, width } = slideLayoutForAspectRatio(
        deck.aspectRatio,
      );
      const [{ default: PptxGenJS }, pngDataUrls] = await Promise.all([
        import("pptxgenjs"),
        rasterizeVisualDeckSlides(deck, 1.5),
      ]);
      const pptx = new PptxGenJS();
      pptx.layout = layout;
      pptx.author = "SourceWeft";
      pptx.company = "SourceWeft";
      pptx.subject = title;
      pptx.title = title;

      for (const [index, pngDataUrl] of pngDataUrls.entries()) {
        pptx.addSlide().addImage({
          altText: `${title} slide ${index + 1}`,
          data: pngDataUrl,
          h: height,
          w: width,
          x: 0,
          y: 0,
        });
      }

      await pptx.writeFile({
        compression: true,
        fileName: suggestedExportName(title, "pptx"),
      });
      toast.success("Visual PPTX export started.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export this deck as a visual PPTX.",
      );
    } finally {
      deck?.dispose();
      setExporting(false);
    }
  }, [previewUrl, title]);

  const handleExportHtml = useCallback(async () => {
    setExportingHtml(true);
    try {
      const response = await fetch(previewUrl, { credentials: "include" });
      if (!response.ok) {
        throw new Error("Could not load the HTML deck for export.");
      }
      const html = await response.text();
      downloadBlob(
        new Blob([html], { type: "text/html;charset=utf-8" }),
        suggestedExportName(title, "html"),
      );
      toast.success("HTML export started.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export this deck as HTML.",
      );
    } finally {
      setExportingHtml(false);
    }
  }, [previewUrl, title]);

  const handleExportEditablePptx = useCallback(async () => {
    setExportingEditable(true);
    let deck: PreparedVisualDeckExport | null = null;
    try {
      deck = await prepareVisualDeckExport(previewUrl);
      const { height, layout, width } = slideLayoutForAspectRatio(
        deck.aspectRatio,
      );
      const { exportToPptx } = await import("dom-to-pptx");
      const fonts = resolveVisualDeckPptxFonts(deck.doc);
      await exportToPptx(deck.slideElements, {
        autoEmbedFonts: true,
        fileName: suggestedExportName(`${title} editable`, "pptx"),
        fonts,
        height,
        layout,
        svgAsVector: true,
        width,
      });
      toast.success("Editable PPTX export started.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export this deck as an editable PPTX.",
      );
    } finally {
      deck?.dispose();
      setExportingEditable(false);
    }
  }, [previewUrl, title]);

  const handleExportVideo = useCallback(async () => {
    setExportingVideo(true);
    try {
      await exportVisualDeckVideo({
        fileUrl: previewUrl,
        narrationEnabled: false,
        secondsPerSlide: VIDEO_EXPORT_SECONDS_PER_SLIDE,
        title,
        transitionSeconds: VIDEO_EXPORT_TRANSITION_SECONDS,
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export this deck as video.",
      );
    } finally {
      setExportingVideo(false);
    }
  }, [previewUrl, title]);

  return (
    <div className="space-y-3">
      <div className="w-full overflow-hidden rounded-xl border bg-background shadow-sm">
        <div className="grid gap-2 border-b px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0 pr-2">
            <p className="whitespace-nowrap text-xs font-medium text-foreground">
              Deck Preview
            </p>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            <div className="grid grid-cols-3 overflow-hidden rounded-md border bg-muted/20 sm:flex">
              <Button
                className="h-7 justify-center gap-1.5 rounded-none border-r px-2.5 text-[11px]"
                disabled={isExportingAny}
                onClick={handleExportHtml}
                size="xs"
                type="button"
                variant="ghost"
              >
                {exportingHtml ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileCode2 className="size-3.5" />
                )}
                HTML
              </Button>
              <Button
                className="h-7 justify-center gap-1.5 rounded-none border-r px-2.5 text-[11px]"
                disabled={isExportingAny}
                onClick={handleExportEditablePptx}
                size="xs"
                title="Download an editable PowerPoint version"
                type="button"
                variant="ghost"
              >
                {exportingEditable ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileType2 className="size-3.5" />
                )}
                Editable
              </Button>
              <Button
                className="h-7 justify-center gap-1.5 rounded-none px-2.5 text-[11px]"
                disabled={isExportingAny}
                onClick={handleExportVideo}
                size="xs"
                type="button"
                variant="ghost"
              >
                {exportingVideo ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Video className="size-3.5" />
                )}
                Video
              </Button>
            </div>
            <Button
              className="h-7 justify-center gap-1.5 px-3 text-[11px] shadow-sm sm:min-w-28"
              disabled={isExportingAny}
              onClick={handleExportPptx}
              size="xs"
              type="button"
            >
              {exporting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileType2 className="size-3.5" />
              )}
              Visual PPTX
            </Button>
          </div>
        </div>
        <div
          className="relative w-full overflow-hidden bg-[#0b1017]"
          ref={containerRef}
          style={
            frameHeight
              ? { height: `${frameHeight}px` }
              : { aspectRatio: numericAspectRatio(aspectRatio) }
          }
        >
          {isFrameLoading ? (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background/70">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          <iframe
            key={previewUrl}
            className="block h-full w-full border-0 bg-[#0b1017]"
            onLoad={() => {
              setIsFrameLoading(false);
            }}
            sandbox="allow-scripts"
            src={previewUrl}
            title={`${title} preview`}
          />
        </div>
      </div>
    </div>
  );
}

function videoPresentationDownloadName(
  title: string,
  extension: "mp4" | "webm",
) {
  const normalized = title
    .normalize("NFKC")
    .trim()
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 120);
  const fallback = normalized || "video-presentation";
  return fallback.toLowerCase().endsWith(`.${extension}`)
    ? fallback
    : `${fallback}.${extension}`;
}

async function renderVideoPresentationOnWeb(input: {
  format: RemotionWebRenderFormat;
  spec: RenderableVideoPresentationSpec;
  onProgress: (progress: number) => void;
  signal: AbortSignal;
}) {
  const { renderMediaOnWeb } = await import("@remotion/web-renderer");
  const { getBlob } = await renderMediaOnWeb({
    composition: {
      component: VideoPresentationComposition,
      durationInFrames: getVideoDurationInFrames(input.spec),
      fps: input.spec.fps,
      height: input.spec.height,
      id: "video-presentation",
      width: input.spec.width,
      defaultProps: { spec: input.spec },
    },
    container: input.format.container,
    delayRenderTimeoutInMilliseconds:
      VIDEO_PRESENTATION_AUDIO_DELAY_RENDER_TIMEOUT_MS,
    inputProps: { spec: input.spec },
    onProgress: ({ progress }) => input.onProgress(progress),
    signal: input.signal,
    videoBitrate: "high",
    videoCodec: input.format.videoCodec,
  });
  return getBlob();
}

function VideoPresentationPreview({
  artifact,
  title,
}: {
  artifact: ArtifactListItem;
  title: string;
}) {
  const payload = payloadRecord(artifact);
  const spec = useVideoPresentationSpec(payload);
  const isPreparing =
    artifact.status === "pending" || artifact.status === "running";
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [renderFormat, setRenderFormat] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const durationSeconds = spec ? getVideoDurationSeconds(spec) : null;
  const generation =
    payload.generation &&
    typeof payload.generation === "object" &&
    !Array.isArray(payload.generation)
      ? (payload.generation as Record<string, unknown>)
      : null;
  const generationError =
    typeof generation?.errorMessage === "string"
      ? generation.errorMessage
      : typeof artifact.errorMessage === "string"
        ? artifact.errorMessage
        : null;

  const handleDownloadVideo = useCallback(async () => {
    if (!spec || isRendering) {
      return;
    }

    setIsRendering(true);
    setRenderProgress(0);
    setRenderFormat(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const format = await chooseRemotionWebRenderFormat();
      if (!format) {
        throw new Error(
          "Your browser does not support in-browser video rendering.",
        );
      }
      setRenderFormat(format.label);
      const blob = await renderVideoPresentationOnWeb({
        format,
        spec,
        onProgress: setRenderProgress,
        signal: controller.signal,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = videoPresentationDownloadName(title, format.extension);
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        toast.error("Video export failed", {
          description:
            error instanceof Error
              ? error.message
              : "Could not render this video in the browser.",
        });
      }
    } finally {
      setIsRendering(false);
      setRenderProgress(null);
      setRenderFormat(null);
      abortControllerRef.current = null;
    }
  }, [isRendering, spec, title]);

  const handleCancelRender = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  if (!spec && isPreparing) {
    return (
      <div className="rounded-xl border bg-background p-4 text-center shadow-sm">
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        <p className="mt-3 text-sm font-medium text-foreground">
          Preparing video project
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {resolveVideoProjectStageLabel(payload)}
        </p>
      </div>
    );
  }

  if (!spec) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
        <p className="text-sm font-medium text-destructive">
          {artifact.status === "failed"
            ? "Video project generation failed"
            : "Video project is unavailable"}
        </p>
        <p className="mt-2 text-xs leading-5 text-destructive/80">
          {generationError ??
            "The video presentation payload does not contain a valid scene spec."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="w-full overflow-hidden rounded-xl border bg-background shadow-sm">
        <div className="grid gap-2 border-b px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0 pr-2">
            <p className="whitespace-nowrap text-xs font-medium text-foreground">
              Video Presentation
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {spec.slides.length} slides
              {durationSeconds
                ? ` · ${durationSeconds.toFixed(1)}s`
                : null} · {spec.fps}fps
            </p>
          </div>
          {isRendering ? (
            <div className="flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              <span className="text-[11px] font-medium text-muted-foreground">
                Rendering {renderFormat ?? "video"}{" "}
                {renderProgress !== null
                  ? `${Math.round(renderProgress * 100)}%`
                  : ""}
              </span>
              <Button
                className="h-7 px-2 text-[11px]"
                onClick={handleCancelRender}
                size="xs"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              className="h-7 justify-center gap-1.5 px-3 text-[11px] shadow-sm sm:min-w-32"
              onClick={() => void handleDownloadVideo()}
              size="xs"
              type="button"
            >
              <Video className="size-3.5" />
              Download Video
            </Button>
          )}
        </div>
        <div className="bg-[#0b1017] p-2">
          <Player
            className="mx-auto max-h-[calc(100vh-12rem)] w-full overflow-hidden rounded-lg bg-black"
            component={VideoPresentationComposition}
            compositionHeight={spec.height}
            compositionWidth={spec.width}
            controls
            durationInFrames={getVideoDurationInFrames(spec)}
            fps={spec.fps}
            inputProps={{ spec }}
            style={{
              aspectRatio: `${spec.width} / ${spec.height}`,
              maxWidth: "100%",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function PptxViewJsPreview({
  fileUrl,
  title,
}: {
  fileUrl: string;
  title: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<import("pptxviewjs").PPTXViewer | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slideCount, setSlideCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [{ PPTXViewer }, response] = await Promise.all([
          import("pptxviewjs"),
          fetch(fileUrl, { credentials: "include" }),
        ]);
        if (!response.ok) {
          throw new Error("Could not load the PPTX file.");
        }
        const buffer = await response.arrayBuffer();
        if (cancelled) {
          return;
        }
        const viewer = new PPTXViewer({
          backgroundColor: "#ffffff",
          canvas,
          slideSizeMode: "fit",
        });
        await viewer.loadFile(buffer);
        if (cancelled) {
          viewer.destroy();
          return;
        }
        await viewer.render(canvas, { quality: "high" });
        if (cancelled) {
          viewer.destroy();
          return;
        }
        viewerRef.current?.destroy();
        viewerRef.current = viewer;
        setSlideCount(viewer.getSlideCount());
        setCurrentSlide(viewer.getCurrentSlideIndex());
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "PPTX preview failed to load.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, [fileUrl]);

  const goToSlide = async (direction: -1 | 1) => {
    const viewer = viewerRef.current;
    const canvas = canvasRef.current;
    if (!viewer || !canvas) {
      return;
    }
    const nextIndex = Math.max(
      0,
      Math.min(slideCount - 1, currentSlide + direction),
    );
    await viewer.goToSlide(nextIndex, canvas);
    setCurrentSlide(viewer.getCurrentSlideIndex());
  };

  if (error) {
    return (
      <SlidesFallback
        detail={`Preview renderer failed: ${error}. You can still open or download the PowerPoint.`}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">
            Editable PowerPoint
          </p>
          <p className="text-[11px] text-muted-foreground">
            {slideCount > 0
              ? `Slide ${currentSlide + 1} of ${slideCount}`
              : "Loading preview"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            disabled={loading || currentSlide <= 0}
            onClick={() => void goToSlide(-1)}
            size="icon-xs"
            title="Previous slide"
            type="button"
            variant="ghost"
          >
            <ChevronLeft className="size-3.5" />
            <span className="sr-only">Previous slide</span>
          </Button>
          <Button
            disabled={loading || currentSlide >= slideCount - 1}
            onClick={() => void goToSlide(1)}
            size="icon-xs"
            title="Next slide"
            type="button"
            variant="ghost"
          >
            <ChevronRight className="size-3.5" />
            <span className="sr-only">Next slide</span>
          </Button>
        </div>
      </div>
      <div className="relative flex min-h-80 items-center justify-center bg-muted/40 p-3">
        {loading ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-background/70">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        <canvas
          className="h-auto w-full max-w-[calc((100vh-15rem)*16/9)] rounded-md bg-white shadow-sm"
          ref={canvasRef}
          title={`${title} preview canvas`}
        />
      </div>
    </div>
  );
}

export function ArtifactPreviewPanel({
  artifact,
  className,
  layout = "panel",
  onClose,
  workspaceId,
}: {
  artifact: ArtifactListItem;
  className?: string;
  layout?: ArtifactPreviewLayout;
  onClose?: () => void;
  workspaceId?: string | null;
}) {
  const pageUrl = resolveArtifactPageUrl({ artifact, workspaceId });
  const proxyFileUrl = resolveArtifactProxyFileUrl({ artifact, workspaceId });
  const downloadUrl = resolveArtifactDownloadUrl({ artifact, workspaceId });
  const title = artifactTitle(artifact);
  const isVideoPresentation = artifact.artifactType === "video_presentation";
  const canOpenFile = artifact.capabilities?.canOpenFile ?? Boolean(pageUrl);
  const canDownloadFile = artifact.capabilities?.canDownloadFile ?? Boolean(downloadUrl);
  const canPreviewVideo =
    !isVideoPresentation &&
    isVideoArtifact(artifact) &&
    artifact.status === "ready" &&
    Boolean(proxyFileUrl);
  const canPreviewImage =
    artifact.artifactType === "image" &&
    artifact.status === "ready" &&
    Boolean(proxyFileUrl);
  const slidesGenerationMode =
    artifact.artifactType === "slides"
      ? resolveSlidesGenerationMode(artifact)
      : null;
  const slidesAspectRatio =
    artifact.artifactType === "slides"
      ? resolveSlidesAspectRatio(artifact)
      : null;
  const slidesCount =
    artifact.artifactType === "slides" ? resolveSlidesCount(artifact) : 0;

  useEffect(() => {
    if (!onClose) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [onClose]);

  const handleOpenExternal = () => {
    if (artifact.capabilities?.canRenderClientVideo) {
      toast.error("Video presentations are downloaded from the preview card.");
      return;
    }
    if (!canOpenFile || !pageUrl) {
      toast.error("This artifact has no preview file.");
      return;
    }
    window.open(pageUrl, "_blank", "noopener,noreferrer");
  };

  const handleDownload = () => {
    if (artifact.capabilities?.canRenderClientVideo) {
      toast.error("Use Download Video from the preview card.");
      return;
    }
    if (!canDownloadFile || !downloadUrl) {
      toast.error("This artifact has no downloadable file.");
      return;
    }

    const link = document.createElement("a");
    link.href = downloadUrl;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const isPageLayout = layout === "page";

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col bg-background text-foreground",
        isPageLayout ? "overflow-hidden" : "border-l",
        className,
      )}
    >
      <div
        className={cn(
          "shrink-0 border-b bg-muted/20",
          isPageLayout ? "px-4 py-3 sm:px-5" : "px-3 py-3",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          {onClose ? (
            <Button
              className="gap-1.5"
              onClick={onClose}
              size="xs"
              type="button"
              variant="ghost"
            >
              {isPageLayout ? (
                <X className="size-3.5" />
              ) : (
                <ArrowLeft className="size-3.5" />
              )}
              {isPageLayout ? "Close" : "Artifacts"}
            </Button>
          ) : (
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Artifact Preview
              </p>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              disabled={!pageUrl || !canOpenFile}
              onClick={handleOpenExternal}
              size="icon-xs"
              title="Open artifact in new tab"
              type="button"
              variant="ghost"
            >
              <ExternalLink className="size-3.5" />
              <span className="sr-only">Open artifact in new tab</span>
            </Button>
            <Button
              disabled={!downloadUrl || !canDownloadFile}
              onClick={handleDownload}
              size="icon-xs"
              title="Download artifact"
              type="button"
              variant="ghost"
            >
              <Download className="size-3.5" />
              <span className="sr-only">Download artifact</span>
            </Button>
          </div>
        </div>

        <div className="mt-2 min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">
            {title}
          </h3>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <TypeBadge label={artifactTypeLabel(artifact.artifactType)} />
            <TypeBadge label={artifact.status} />
            <span>{new Date(artifact.createdAt).toLocaleString()}</span>
            {artifact.completedAt ? (
              <span>
                completed {new Date(artifact.completedAt).toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto bg-muted/10",
          isPageLayout ? "px-4 py-4 sm:px-5" : "px-3 py-3",
        )}
      >
        {isVideoPresentation ? (
          <VideoPresentationPreview artifact={artifact} title={title} />
        ) : artifact.status === "pending" || artifact.status === "running" ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-background/70 px-5 text-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {isVideoPresentation
                  ? resolveVideoProjectStageLabel(payloadRecord(artifact))
                  : "Artifact is still generating"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {isVideoPresentation
                  ? "The final MP4/WebM will be rendered in your browser when you click Download Video."
                  : "Preview will be available when the artifact is ready."}
              </p>
            </div>
          </div>
        ) : artifact.status === "failed" ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
            <p className="text-sm font-medium text-destructive">
              Artifact generation failed
            </p>
            <p className="mt-2 text-xs leading-5 text-destructive/80">
              {artifact.errorMessage || "No error details were saved."}
            </p>
          </div>
        ) : canPreviewVideo && proxyFileUrl ? (
          <VideoArtifactPreview fileUrl={proxyFileUrl} title={title} />
        ) : canPreviewImage && proxyFileUrl ? (
          <div className="flex min-h-80 items-center justify-center rounded-xl bg-background p-2">
            <GeneratedImagePreview
              className="w-full [&>span]:mx-auto [&>span]:grid [&>span]:min-h-80 [&>span]:w-full [&>span]:max-w-full [&>span]:place-items-center [&>span>img]:max-h-[calc(100vh-15rem)] [&>span>img]:max-w-full"
              downloadUrl={downloadUrl ?? proxyFileUrl}
              imageUrl={proxyFileUrl}
              title={title}
            />
          </div>
        ) : artifact.artifactType === "slides" &&
          proxyFileUrl &&
          slidesGenerationMode === "visual_html" ? (
          <VisualHtmlDeckPreview
            aspectRatio={slidesAspectRatio}
            previewUrl={proxyFileUrl}
            title={title}
          />
        ) : artifact.artifactType === "slides" &&
          proxyFileUrl &&
          slidesGenerationMode === "editable_native" ? (
          <PptxViewJsPreview fileUrl={proxyFileUrl} title={title} />
        ) : artifact.artifactType === "slides" && pageUrl ? (
          <SlidesFallback />
        ) : (
          <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed bg-background/70 px-5 text-center">
            <div>
              <Sparkles className="mx-auto mb-3 size-5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">
                Preview is not available
              </p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                This artifact can still be opened or downloaded from the toolbar
                when a file is available.
              </p>
            </div>
          </div>
        )}

        {artifact.promptText ? (
          <div className="mt-3 rounded-xl border bg-background/70 p-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Prompt
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {artifact.promptText}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
