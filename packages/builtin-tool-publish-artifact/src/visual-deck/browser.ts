/// <reference path="./dom-to-pptx.d.ts" />
import { artifactRenderHost } from "@sourceweft/contracts/artifact-ui";
import { stripExecutableVisualDeckHtmlForExport } from "./html-sanitize";
import {
  resolveVisualDeckDocumentExportProfile,
  type VisualDeckExportProfile,
} from "./profile";

const VISUAL_DECK_RASTER_CONCURRENCY = 2;
const VIDEO_EXPORT_BITRATE = 5_000_000;
const VIDEO_EXPORT_FPS = 24;
const VIDEO_EXPORT_MAX_WIDTH = 1280;

export type VisualDeckFontMetadata = {
  body?: VisualDeckFontReference;
  fonts?: VisualDeckFontReference[];
  heading?: VisualDeckFontReference;
};

export type VisualDeckFontReference = {
  cssFamily?: string;
  embedUrl?: string;
  family?: string;
  key?: string;
  roles?: string[];
  weights?: number[];
};

export type PreparedVisualDeckExport = {
  dimensions: {
    height: number;
    width: number;
  };
  dispose: () => void;
  doc: Document;
  iframe: HTMLIFrameElement;
  profile: VisualDeckExportProfile;
  slideElements: HTMLElement[];
};

type VideoExportFormat = {
  extension: "mp4" | "webm";
  label: string;
  mimeType: string;
};

type VideoPresentationAudioTrack = {
  assetUrl: string;
  fileName?: string;
  mimeType?: string;
  slideNumber: number;
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export function suggestedVisualDeckExportName(
  title: string,
  extension: string,
) {
  const compact = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${compact || "presentation"}.${extension}`;
}

export function downloadVisualDeckBlob(blob: Blob, fileName: string) {
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

export async function prepareVisualDeckExport(input: {
  fileUrl: string;
  payload?: Record<string, unknown>;
}) {
  const response = await fetch(input.fileUrl, { credentials: "include" });
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
    const profile = resolveVisualDeckDocumentExportProfile({
      doc,
      payload: input.payload ?? {},
    });
    const dimensions = {
      height: profile.slideSize.heightPx,
      width: profile.slideSize.widthPx,
    };
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
      dimensions,
      dispose: () => iframe.remove(),
      doc,
      iframe,
      profile,
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
  shell.dataset.aspectRatio = deck.profile.aspectRatio;
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

export async function exportVisualDeckHtml(input: {
  fileUrl: string;
  title: string;
}) {
  const response = await fetch(input.fileUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error("Could not load the HTML deck for export.");
  }
  const html = await response.text();
  downloadVisualDeckBlob(
    new Blob([html], { type: "text/html;charset=utf-8" }),
    suggestedVisualDeckExportName(input.title, "html"),
  );
}

export async function exportVisualDeckPptx(input: {
  fileUrl: string;
  payload?: Record<string, unknown>;
  title: string;
}) {
  let deck: PreparedVisualDeckExport | null = null;
  try {
    deck = await prepareVisualDeckExport(input);
    const { heightIn, layout, widthIn } = deck.profile.pptx;
    const [{ default: PptxGenJS }, pngDataUrls] = await Promise.all([
      import("pptxgenjs"),
      rasterizeVisualDeckSlides(deck, 1.5),
    ]);
    const pptx = new PptxGenJS();
    pptx.layout = layout;
    pptx.author = "SourceWeft";
    pptx.company = "SourceWeft";
    pptx.subject = input.title;
    pptx.title = input.title;

    for (const [index, pngDataUrl] of pngDataUrls.entries()) {
      pptx.addSlide().addImage({
        altText: `${input.title} slide ${index + 1}`,
        data: pngDataUrl,
        h: heightIn,
        w: widthIn,
        x: 0,
        y: 0,
      });
    }

    await pptx.writeFile({
      compression: true,
      fileName: suggestedVisualDeckExportName(input.title, "pptx"),
    });
  } finally {
    deck?.dispose();
  }
}

export async function exportVisualDeckEditablePptx(input: {
  fileUrl: string;
  payload?: Record<string, unknown>;
  title: string;
}) {
  let deck: PreparedVisualDeckExport | null = null;
  try {
    deck = await prepareVisualDeckExport(input);
    const { heightIn, layout, widthIn } = deck.profile.pptx;
    const { exportToPptx } = await import("dom-to-pptx");
    const fonts = resolveVisualDeckPptxFonts(deck.doc);
    await exportToPptx(deck.slideElements, {
      autoEmbedFonts: true,
      fileName: suggestedVisualDeckExportName(`${input.title} editable`, "pptx"),
      fonts,
      height: heightIn,
      layout,
      svgAsVector: true,
      width: widthIn,
    });
  } finally {
    deck?.dispose();
  }
}

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

function easeInOut(value: number) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

async function waitForVideoFrame(frameMs: number) {
  await new Promise((resolve) => window.setTimeout(resolve, frameMs));
}

function resolveAssetFetchUrl(value: string) {
  // Backend-relative asset paths are absolutized by the app shell; the export
  // pipeline must reach the API directly rather than through an artifact route.
  return artifactRenderHost().resolveApiAssetUrl(value);
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

export async function exportVisualDeckVideo(input: {
  audioTracks?: VideoPresentationAudioTrack[];
  fileUrl: string;
  fps?: number;
  narrationEnabled?: boolean;
  payload?: Record<string, unknown>;
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
    deck = await prepareVisualDeckExport(input);
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
    downloadVisualDeckBlob(
      blob,
      suggestedVisualDeckExportName(input.title, videoFormat.extension),
    );
    return videoFormat;
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
