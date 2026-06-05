import { NextResponse, type NextRequest } from "next/server";
import { apiBaseUrl } from "../../../lib/api-base-url";

const VISUAL_DECK_HTML_CSP = [
  "sandbox allow-scripts allow-downloads allow-forms allow-popups",
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

const GENERIC_HTML_ARTIFACT_CSP = [
  "sandbox",
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

function badRequest(message: string) {
  return new NextResponse(message, { status: 400 });
}

function isSafeFlatArtifactAssetFileName(fileName: string) {
  const normalized = fileName.trim();
  if (!normalized || normalized === "." || normalized === "..") {
    return false;
  }
  return !normalized.includes("/") && !normalized.includes("\\") && !normalized.includes("..");
}

export function patchVisualDeckHtml(html: string) {
  const style = `
<style id="sourceweft-preview-ui-patch">
html[data-sourceweft-deck="visual_html"] body:not(.sw-export) {
  overflow: hidden !important;
}
html[data-sourceweft-deck="visual_html"] body:not(.sw-export) .deck-viewport {
  inset: 0 0 48px !important;
  display: block !important;
  width: 100vw !important;
  min-height: 0 !important;
  overflow: hidden !important;
  padding: 0 !important;
}
html[data-sourceweft-deck="visual_html"] body:not(.sw-export) .deck-shell {
  position: absolute !important;
  transform-origin: top left !important;
}
html[data-sourceweft-deck="visual_html"] body:not(.sw-export) .deck-controls {
  display: none !important;
}
html[data-sourceweft-deck="visual_html"] body:not(.sw-export) .sourceweft-preview-controls {
  left: 50% !important;
  right: auto !important;
  bottom: 8px !important;
  display: flex !important;
  flex-wrap: nowrap !important;
  justify-content: center !important;
  width: min(320px, calc(100vw - 28px)) !important;
  height: 34px !important;
  padding: 0 8px !important;
  gap: 6px !important;
  transform: translateX(-50%) !important;
  position: fixed !important;
  z-index: 2147483647 !important;
  align-items: center !important;
  overflow: hidden !important;
  border: 1px solid rgba(255,255,255,.16) !important;
  border-radius: 999px !important;
  background: rgba(8, 12, 18, .74) !important;
  color: #f8fafc !important;
  box-shadow: 0 18px 46px rgba(0,0,0,.24) !important;
  backdrop-filter: blur(16px) !important;
}
html[data-sourceweft-deck="visual_html"] body:not(.sw-export) .sourceweft-preview-controls button {
  flex: 0 0 auto !important;
  width: 42px !important;
  min-width: 42px !important;
  max-width: 42px !important;
  height: 26px !important;
  padding: 0 !important;
  overflow: hidden !important;
  border: 1px solid rgba(255,255,255,.18) !important;
  border-radius: 999px !important;
  background: rgba(255,255,255,.08) !important;
  color: inherit !important;
  font: inherit !important;
  text-align: center !important;
  white-space: nowrap !important;
  cursor: pointer !important;
}
html[data-sourceweft-deck="visual_html"] body:not(.sw-export) .sourceweft-preview-count {
  flex: 1 1 auto !important;
  min-width: 68px !important;
  overflow: hidden !important;
  color: rgba(248,250,252,.92) !important;
  font-size: 12px !important;
  font-weight: 760 !important;
  line-height: 1 !important;
  text-align: center !important;
  white-space: nowrap !important;
  font-variant-numeric: tabular-nums !important;
}
</style>`;
  const script = `
<script id="sourceweft-preview-ui-script">
(() => {
  const ready = () => {
    if (document.body.classList.contains("sw-export")) return;
    const slides = Array.from(document.querySelectorAll(".sw-slide"));
    if (slides.length <= 0 || document.querySelector(".sourceweft-preview-controls")) return;
    const shell = document.querySelector(".deck-shell");
    const viewport = document.querySelector(".deck-viewport");
    const originalControls = document.querySelector(".deck-controls");
    const controls = document.createElement("nav");
    controls.className = "sourceweft-preview-controls";
    controls.setAttribute("aria-label", "Slide navigation");
    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "\\u2039";
    prev.setAttribute("aria-label", "Previous slide");
    const count = document.createElement("span");
    count.className = "sourceweft-preview-count";
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "\\u203A";
    next.setAttribute("aria-label", "Next slide");
    controls.append(prev, count, next);
    document.body.appendChild(controls);
    const readNumber = (value, fallback) => {
      const parsed = Number.parseFloat(String(value || "").replace("px", ""));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const fitPreview = () => {
      if (!(shell instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return;
      const rootStyle = getComputedStyle(document.documentElement);
      const w = readNumber(shell.dataset.slideWidth, readNumber(rootStyle.getPropertyValue("--slide-w"), 1920));
      const h = readNumber(shell.dataset.slideHeight, readNumber(rootStyle.getPropertyValue("--slide-h"), 1080));
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const scale = Math.max(0.1, Math.min(rect.width / w, rect.height / h));
      shell.style.position = "absolute";
      shell.style.width = w + "px";
      shell.style.height = h + "px";
      shell.style.left = Math.max(0, (rect.width - w * scale) / 2) + "px";
      shell.style.top = Math.max(0, (rect.height - h * scale) / 2) + "px";
      shell.style.transformOrigin = "top left";
      shell.style.transform = "scale(" + scale + ")";
    };
    const activeIndex = () => Math.max(0, slides.findIndex((slide) => slide.classList.contains("is-active")));
    const parentOrigin = (() => {
      try {
        return document.referrer ? new URL(document.referrer).origin : "";
      } catch {
        return "";
      }
    })();
    const publishState = () => {
      if (!parentOrigin) return;
      window.parent?.postMessage({
        type: "sourceweft:visual-deck-state",
        current: activeIndex(),
        total: slides.length
      }, parentOrigin);
    };
    const update = () => {
      fitPreview();
      const current = activeIndex();
      const label = (current + 1) + " / " + slides.length;
      if (count.textContent !== label) count.textContent = label;
      prev.disabled = current <= 0;
      next.disabled = current >= slides.length - 1;
      publishState();
    };
    let pendingUpdate = false;
    const scheduleUpdate = () => {
      if (pendingUpdate) return;
      pendingUpdate = true;
      window.requestAnimationFrame(() => {
        pendingUpdate = false;
        update();
      });
    };
    const clickOriginal = (selector) => {
      const control = originalControls?.querySelector(selector);
      if (control instanceof HTMLElement) {
        control.click();
        return true;
      }
      return false;
    };
    const go = (direction) => {
      const selector = direction < 0 ? "[data-prev], .prev, .previous" : "[data-next], .next";
      if (!clickOriginal(selector) && window.SourceWeftDeck) {
        if (direction < 0) window.SourceWeftDeck.previous?.();
        else window.SourceWeftDeck.next?.();
      }
      scheduleUpdate();
      window.setTimeout(scheduleUpdate, 120);
    };
    window.addEventListener("message", (event) => {
      if (parentOrigin && event.origin !== parentOrigin) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== "sourceweft:visual-deck-command") return;
      if (data.command === "next") go(1);
      else if (data.command === "previous") go(-1);
      else if (data.command === "state") scheduleUpdate();
    });
    prev.addEventListener("click", () => go(-1));
    next.addEventListener("click", () => go(1));
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("keydown", () => {
      scheduleUpdate();
      window.setTimeout(scheduleUpdate, 120);
    });
    scheduleUpdate();
    window.setTimeout(scheduleUpdate, 80);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  } else {
    ready();
  }
})();
</script>`;
  const withStyle = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${style}</head>`)
    : `${style}${html}`;
  return /<\/body>/i.test(withStyle)
    ? withStyle.replace(/<\/body>/i, `${script}</body>`)
    : `${withStyle}${script}`;
}

export async function proxyArtifactFile(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  const artifactId = request.nextUrl.searchParams.get("artifactId");
  const assetFileName = request.nextUrl.searchParams.get("assetFileName");
  const isDownload = request.nextUrl.searchParams.get("download") === "1";

  if (!workspaceId || !artifactId) {
    return badRequest("workspaceId and artifactId are required.");
  }

  if (assetFileName && !isSafeFlatArtifactAssetFileName(assetFileName)) {
    return badRequest("assetFileName must be a flat artifact asset file name.");
  }

  const upstreamAction = assetFileName
    ? `assets/${encodeURIComponent(assetFileName)}`
    : isDownload
      ? "download"
      : "file";
  const upstreamUrl = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/${upstreamAction}`,
    apiBaseUrl,
  );
  const response = await fetch(upstreamUrl, {
    cache: "no-store",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
    },
  });

  if (!response.ok) {
    return new NextResponse(await response.text(), {
      status: response.status,
      statusText: response.statusText,
    });
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const artifactRenderer = response.headers.get("x-sourceweft-artifact-renderer");
  const headers = new Headers({
    "Cache-Control": "private, max-age=30",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  const contentDisposition = response.headers.get("content-disposition");
  if (contentDisposition) {
    headers.set("Content-Disposition", contentDisposition);
  }

  if (
    !isDownload &&
    artifactRenderer === "visual_html_deck" &&
    contentType.toLowerCase().includes("text/html")
  ) {
    headers.set("Content-Security-Policy", VISUAL_DECK_HTML_CSP);
    return new NextResponse(patchVisualDeckHtml(await response.text()), {
      headers,
    });
  }

  if (!isDownload && contentType.toLowerCase().includes("text/html")) {
    headers.set("Content-Security-Policy", GENERIC_HTML_ARTIFACT_CSP);
  }

  return new NextResponse(response.body, { headers });
}
