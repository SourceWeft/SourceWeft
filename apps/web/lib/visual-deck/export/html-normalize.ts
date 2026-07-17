function isTransparentCssColor(value: string) {
  const normalized = value.trim().toLowerCase();
  const compact = normalized.replace(/\s+/g, "");
  return (
    !normalized ||
    normalized === "transparent" ||
    normalized === "none" ||
    compact === "rgba(0,0,0,0)" ||
    normalized === "rgba(0, 0, 0, 0)" ||
    normalized === "rgb(0 0 0 / 0)" ||
    normalized.endsWith(" / 0)") ||
    normalized.endsWith(" / 0%)") ||
    /\/0(?:\.0+)?%?\)$/.test(compact) ||
    /^(rgba|hsla)\([^)]*,0(?:\.0+)?%?\)$/.test(compact)
  );
}

function hasRenderableBackground(style: CSSStyleDeclaration | null) {
  return Boolean(
    style &&
      (!isTransparentCssColor(style.backgroundColor) ||
        hasRenderableBackgroundImage(style.backgroundImage)),
  );
}

function hasRenderableBackgroundImage(value: string) {
  const normalized = value.trim().toLowerCase();
  return Boolean(normalized && normalized !== "none");
}

function findEffectiveBackgroundStyleWithSource(element: HTMLElement) {
  const view = element.ownerDocument.defaultView;
  if (!view) {
    return null;
  }
  let current: HTMLElement | null = element;
  while (current) {
    const style = view.getComputedStyle(current);
    if (
      !isTransparentCssColor(style.backgroundColor) ||
      hasRenderableBackgroundImage(style.backgroundImage)
    ) {
      return { source: current, style };
    }
    current = current.parentElement;
  }
  const bodyStyle = view.getComputedStyle(element.ownerDocument.body);
  if (hasRenderableBackground(bodyStyle)) {
    return { source: element.ownerDocument.body, style: bodyStyle };
  }
  return {
    source: element.ownerDocument.documentElement,
    style: view.getComputedStyle(element.ownerDocument.documentElement),
  };
}

function findEffectiveBackgroundColor(element: HTMLElement) {
  const view = element.ownerDocument.defaultView;
  if (!view) {
    return null;
  }
  let current: HTMLElement | null = element;
  while (current) {
    const color = view.getComputedStyle(current).backgroundColor;
    if (!isTransparentCssColor(color)) {
      return color;
    }
    current = current.parentElement;
  }
  for (const fallbackElement of [
    element.ownerDocument.body,
    element.ownerDocument.documentElement,
  ]) {
    const color = view.getComputedStyle(fallbackElement).backgroundColor;
    if (!isTransparentCssColor(color)) {
      return color;
    }
  }
  return null;
}

function computedPseudoStyle(
  element: HTMLElement,
  pseudoElement: "::after" | "::before",
  resolvePseudoStyle?: VisualDeckPseudoStyleResolver,
) {
  if (resolvePseudoStyle) {
    return resolvePseudoStyle(element, pseudoElement);
  }
  const view = element.ownerDocument.defaultView;
  if (!view) {
    return null;
  }
  try {
    const style = view.getComputedStyle(element, pseudoElement);
    const content = style.content.trim();
    if (!content || content === "normal") {
      return null;
    }
    return style;
  } catch {
    return null;
  }
}

type VisualDeckPseudoStyleResolver = (
  element: HTMLElement,
  pseudoElement: "::after" | "::before",
) => CSSStyleDeclaration | null;

type VisualDeckExportNormalizationOptions = {
  materializePseudoElements?: boolean;
  resolvePseudoStyle?: VisualDeckPseudoStyleResolver;
  suppressSlideBeforePseudo?: boolean;
};

type VisualDeckExportBackgroundLayerKind = "after" | "base" | "before";

function copyVisualDeckBackgroundStyle(
  layer: HTMLElement,
  style: CSSStyleDeclaration,
  fallbackColor?: string | null,
) {
  layer.style.backgroundAttachment = style.backgroundAttachment;
  layer.style.backgroundBlendMode = style.backgroundBlendMode;
  layer.style.backgroundClip = style.backgroundClip;
  layer.style.backgroundColor = !isTransparentCssColor(style.backgroundColor)
    ? style.backgroundColor
    : (fallbackColor ?? "transparent");
  layer.style.backgroundImage = style.backgroundImage;
  layer.style.backgroundOrigin = style.backgroundOrigin;
  layer.style.backgroundPosition = style.backgroundPosition;
  layer.style.backgroundRepeat = style.backgroundRepeat;
  layer.style.backgroundSize = style.backgroundSize;
}

function copyVisualDeckPaintStyle(
  layer: HTMLElement,
  style: CSSStyleDeclaration,
) {
  layer.style.backdropFilter = style.backdropFilter;
  layer.style.borderRadius = style.borderRadius;
  layer.style.boxShadow = style.boxShadow;
  layer.style.clipPath = style.clipPath;
  layer.style.filter = style.filter;
  layer.style.mixBlendMode = style.mixBlendMode;
  layer.style.opacity = style.opacity;
  layer.style.transform = style.transform;
  layer.style.transformOrigin = style.transformOrigin;
}

function applyVisualDeckPseudoGeometry(
  layer: HTMLElement,
  style: CSSStyleDeclaration,
) {
  layer.style.inset = "0";
  if (style.top !== "auto") {
    layer.style.top = style.top;
  }
  if (style.right !== "auto") {
    layer.style.right = style.right;
  }
  if (style.bottom !== "auto") {
    layer.style.bottom = style.bottom;
  }
  if (style.left !== "auto") {
    layer.style.left = style.left;
  }
  if (style.width !== "auto") {
    layer.style.width = style.width;
  }
  if (style.height !== "auto") {
    layer.style.height = style.height;
  }
}

function createVisualDeckExportBackgroundLayer(
  slideElement: HTMLElement,
  kind: VisualDeckExportBackgroundLayerKind,
  style: CSSStyleDeclaration,
  fallbackColor: string | null,
) {
  const layer = slideElement.ownerDocument.createElement("div");
  layer.dataset.swExportBg = kind;
  layer.setAttribute("aria-hidden", "true");
  layer.style.boxSizing = "border-box";
  layer.style.inset = "0";
  layer.style.pointerEvents = "none";
  layer.style.position = "absolute";
  layer.style.zIndex = kind === "base" ? "0" : kind === "before" ? "1" : "3";
  copyVisualDeckBackgroundStyle(layer, style, fallbackColor);
  copyVisualDeckPaintStyle(layer, style);
  if (kind !== "base") {
    applyVisualDeckPseudoGeometry(layer, style);
  }
  return layer;
}

function shouldCreatePseudoBackgroundLayer(style: CSSStyleDeclaration | null) {
  if (!style || !hasRenderableBackground(style)) {
    return false;
  }
  const content = style.content.trim();
  return Boolean(content && content !== "none" && content !== "normal");
}

function normalizeVisualDeckSlideContentStacking(slideElement: HTMLElement) {
  const view = slideElement.ownerDocument.defaultView;
  if (!view) {
    return;
  }
  for (const child of Array.from(slideElement.children)) {
    if (
      !(child instanceof HTMLElement) ||
      child.dataset.swExportBg ||
      child.tagName === "STYLE"
    ) {
      continue;
    }
    const style = view.getComputedStyle(child);
    if (style.position === "static") {
      child.style.position = "relative";
    }
    if (!style.zIndex || style.zIndex === "auto") {
      child.style.zIndex = "2";
    }
  }
}

function ensureVisualDeckExportNormalizationStyle(doc: Document) {
  if (doc.getElementById("sourceweft-visual-deck-export-normalization")) {
    return;
  }
  const style = doc.createElement("style");
  style.id = "sourceweft-visual-deck-export-normalization";
  style.textContent = `
body.sw-export .sw-slide[data-sw-export-has-before-bg]::before,
body.sw-export .sw-slide[data-sw-export-has-before-bg]:before,
body.sw-export .sw-slide[data-sw-export-has-after-bg]::after {
  content: none !important;
  display: none !important;
}
body.sw-export.sw-export-suppress-slide-before .sw-slide::before,
body.sw-export.sw-export-suppress-slide-before .sw-slide:before,
body.sw-export .sw-slide[data-sw-export-suppress-before]::before,
body.sw-export .sw-slide[data-sw-export-suppress-before]:before,
.sw-slide[data-sw-export-suppress-before]::before,
.sw-slide[data-sw-export-suppress-before]:before {
  all: initial !important;
  content: none !important;
  display: none !important;
  background: none !important;
  background-image: none !important;
  box-shadow: none !important;
  opacity: 0 !important;
  filter: none !important;
  mix-blend-mode: normal !important;
  backdrop-filter: none !important;
  pointer-events: none !important;
}
`;
  doc.head.append(style);
}

export function normalizeVisualDeckSlidesForExport(
  slideElements: HTMLElement[],
  options: VisualDeckExportNormalizationOptions = {},
) {
  const doc = slideElements[0]?.ownerDocument;
  const shouldSuppressBeforePseudo =
    !options.materializePseudoElements &&
    options.suppressSlideBeforePseudo !== false;
  if (doc) {
    ensureVisualDeckExportNormalizationStyle(doc);
    doc.body.classList.toggle(
      "sw-export-suppress-slide-before",
      shouldSuppressBeforePseudo,
    );
  }

  for (const slideElement of slideElements) {
    slideElement
      .querySelectorAll(":scope > [data-sw-export-bg]")
      .forEach((layer) => layer.remove());
    delete slideElement.dataset.swExportHasBeforeBg;
    delete slideElement.dataset.swExportHasAfterBg;
    delete slideElement.dataset.swExportSuppressBefore;
    if (shouldSuppressBeforePseudo) {
      slideElement.dataset.swExportSuppressBefore = "true";
    }

    const view = slideElement.ownerDocument.defaultView;
    if (!view) {
      continue;
    }

    const fallbackColor = findEffectiveBackgroundColor(slideElement);
    const background = findEffectiveBackgroundStyleWithSource(slideElement);
    let needsContentStacking = false;
    if (background && background.source !== slideElement) {
      const slideStyle = view.getComputedStyle(slideElement);
      if (slideStyle.position === "static") {
        slideElement.style.position = "relative";
      }
      slideElement.style.isolation = "isolate";
      slideElement.prepend(
        createVisualDeckExportBackgroundLayer(
          slideElement,
          "base",
          background.style,
          fallbackColor,
        ),
      );
      needsContentStacking = true;
    }

    if (options.materializePseudoElements) {
      const slideStyle = view.getComputedStyle(slideElement);
      if (slideStyle.position === "static") {
        slideElement.style.position = "relative";
      }
      slideElement.style.isolation = "isolate";
      const beforeStyle = computedPseudoStyle(
        slideElement,
        "::before",
        options.resolvePseudoStyle,
      );
      if (beforeStyle && shouldCreatePseudoBackgroundLayer(beforeStyle)) {
        const beforeLayer = createVisualDeckExportBackgroundLayer(
          slideElement,
          "before",
          beforeStyle,
          fallbackColor,
        );
        const baseLayer = slideElement.querySelector(
          ':scope > [data-sw-export-bg="base"]',
        );
        if (baseLayer?.nextSibling) {
          slideElement.insertBefore(beforeLayer, baseLayer.nextSibling);
        } else {
          slideElement.prepend(beforeLayer);
        }
        slideElement.dataset.swExportHasBeforeBg = "true";
        needsContentStacking = true;
      }

      const afterStyle = computedPseudoStyle(
        slideElement,
        "::after",
        options.resolvePseudoStyle,
      );
      if (afterStyle && shouldCreatePseudoBackgroundLayer(afterStyle)) {
        slideElement.append(
          createVisualDeckExportBackgroundLayer(
            slideElement,
            "after",
            afterStyle,
            fallbackColor,
          ),
        );
        slideElement.dataset.swExportHasAfterBg = "true";
        needsContentStacking = true;
      }
    }

    if (needsContentStacking) {
      normalizeVisualDeckSlideContentStacking(slideElement);
    }
  }
}

export function visualDeckSlideBackgroundColor(slideElement: HTMLElement) {
  const baseLayer = slideElement.querySelector<HTMLElement>(
    ':scope > [data-sw-export-bg="base"]',
  );
  if (baseLayer) {
    const color =
      baseLayer.ownerDocument.defaultView?.getComputedStyle(baseLayer)
        .backgroundColor ?? "";
    if (!isTransparentCssColor(color)) {
      return color;
    }
  }
  return findEffectiveBackgroundColor(slideElement) ?? "#ffffff";
}
