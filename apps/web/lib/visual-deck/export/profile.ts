export type VisualDeckAspectRatio = "16:9" | "16:10" | "4:3";

export type VisualDeckPptxLayout =
  | "LAYOUT_16x10"
  | "LAYOUT_4x3"
  | "LAYOUT_WIDE";

export type VisualDeckSlideSize = {
  heightPx: number;
  widthPx: number;
};

export type VisualDeckPptxProfile = {
  heightIn: number;
  layout: VisualDeckPptxLayout;
  widthIn: number;
};

export type VisualDeckExportProfile = {
  aspectRatio: VisualDeckAspectRatio;
  pptx: VisualDeckPptxProfile;
  slideSize: VisualDeckSlideSize;
  source: "html_legacy" | "payload" | "payload_legacy";
};

const LEGACY_PROFILES: Record<
  VisualDeckAspectRatio,
  Omit<VisualDeckExportProfile, "source">
> = {
  "16:9": {
    aspectRatio: "16:9",
    pptx: { heightIn: 7.5, layout: "LAYOUT_WIDE", widthIn: 13.333 },
    slideSize: { heightPx: 1080, widthPx: 1920 },
  },
  "16:10": {
    aspectRatio: "16:10",
    pptx: { heightIn: 6.25, layout: "LAYOUT_16x10", widthIn: 10 },
    slideSize: { heightPx: 1200, widthPx: 1920 },
  },
  "4:3": {
    aspectRatio: "4:3",
    pptx: { heightIn: 7.5, layout: "LAYOUT_4x3", widthIn: 10 },
    slideSize: { heightPx: 1080, widthPx: 1440 },
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function parsePositiveCssNumber(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value.replace("px", ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeAspectRatio(value: unknown): VisualDeckAspectRatio | null {
  const normalized = stringValue(value);
  if (
    normalized === "16:9" ||
    normalized === "16:10" ||
    normalized === "4:3"
  ) {
    return normalized;
  }
  return null;
}

function normalizeLayout(value: unknown): VisualDeckPptxLayout | null {
  const normalized = stringValue(value);
  if (
    normalized === "LAYOUT_WIDE" ||
    normalized === "LAYOUT_16x10" ||
    normalized === "LAYOUT_4x3"
  ) {
    return normalized;
  }
  return null;
}

function explicitProfileFromPayload(
  payload: Record<string, unknown>,
): VisualDeckExportProfile | null {
  const slideSize = record(payload.slideSize);
  const pptx = record(payload.pptx);
  const widthPx = positiveNumber(slideSize?.widthPx);
  const heightPx = positiveNumber(slideSize?.heightPx);
  const layout = normalizeLayout(pptx?.layout);
  const widthIn = positiveNumber(pptx?.widthIn);
  const heightIn = positiveNumber(pptx?.heightIn);

  if (!widthPx || !heightPx || !layout || !widthIn || !heightIn) {
    return null;
  }

  return {
    aspectRatio: normalizeAspectRatio(payload.aspectRatio) ?? "16:9",
    pptx: { heightIn, layout, widthIn },
    slideSize: { heightPx, widthPx },
    source: "payload",
  };
}

export function resolveLegacyVisualDeckProfile(
  aspectRatio: unknown,
  source: "html_legacy" | "payload_legacy" = "payload_legacy",
): VisualDeckExportProfile {
  return {
    ...LEGACY_PROFILES[normalizeAspectRatio(aspectRatio) ?? "16:9"],
    source,
  };
}

export function resolveVisualDeckExportProfile(
  payload: Record<string, unknown>,
): VisualDeckExportProfile {
  return (
    explicitProfileFromPayload(payload) ??
    resolveLegacyVisualDeckProfile(payload.aspectRatio, "payload_legacy")
  );
}

export function resolveVisualDeckDocumentExportProfile(input: {
  doc: Document;
  payload: Record<string, unknown>;
}): VisualDeckExportProfile {
  const payloadProfile = explicitProfileFromPayload(input.payload);
  if (payloadProfile) {
    return payloadProfile;
  }

  const shell = input.doc.querySelector<HTMLElement>(".deck-shell");
  const rootStyle =
    input.doc.defaultView?.getComputedStyle(input.doc.documentElement);
  const fallbackAspectRatio =
    shell?.dataset.aspectRatio ??
    input.doc.documentElement.dataset.sourceweftAspect ??
    input.payload.aspectRatio;
  const fallback = resolveLegacyVisualDeckProfile(
    fallbackAspectRatio,
    "html_legacy",
  );

  return {
    ...fallback,
    slideSize: {
      heightPx:
        parsePositiveCssNumber(shell?.dataset.slideHeight) ??
        parsePositiveCssNumber(rootStyle?.getPropertyValue("--slide-h")) ??
        fallback.slideSize.heightPx,
      widthPx:
        parsePositiveCssNumber(shell?.dataset.slideWidth) ??
        parsePositiveCssNumber(rootStyle?.getPropertyValue("--slide-w")) ??
        fallback.slideSize.widthPx,
    },
  };
}
