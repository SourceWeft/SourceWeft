/** SW's theme provider resolves system preferences into the root light/dark class. */
export function readHostPreviewTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function subscribeHostPreviewTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

// Applied inside the viewer's Shadow DOM. Only chrome is themed; file-authored
// page backgrounds, slide canvases, image pixels and watermarks are untouched.
// :host gives these rules priority over the engine's adopted stylesheet.
export const previewChromeStyles = `
:host .file-viewer-web-shell[data-viewer-theme] {
  --file-viewer-bg: var(--background, Canvas);
  --file-viewer-content-bg: var(--background, Canvas);
  --file-viewer-text: var(--foreground, CanvasText);
  --file-viewer-muted: var(--muted-foreground, GrayText);
  --file-viewer-font: 14px/1.45 var(--font-ui, system-ui);
  --file-viewer-border: var(--border, ButtonBorder);
  --file-viewer-toolbar-bg: var(--background, Canvas);
  --file-viewer-toolbar-border: var(--border, ButtonBorder);
  --file-viewer-toolbar-shadow: none;
  --file-viewer-toolbar-radius: var(--radius, 0.5rem);
  --file-viewer-group-bg: var(--muted, ButtonFace);
  --file-viewer-group-border: var(--border, ButtonBorder);
  --file-viewer-button-color: var(--foreground, CanvasText);
  --file-viewer-button-hover-bg: var(--accent, ButtonFace);
  --file-viewer-button-hover-color: var(--accent-foreground, CanvasText);
  --file-viewer-button-disabled-color: var(--muted-foreground, GrayText);
  --file-viewer-button-radius: var(--radius, 0.5rem);
  --file-viewer-input-bg: var(--background, Canvas);
  --file-viewer-input-color: var(--foreground, CanvasText);
  --file-viewer-focus-ring: var(--ring, Highlight);
}
:host .file-viewer-web-shell[data-viewer-theme] [part~="button"] { font-weight: 500; }
:host .file-viewer-web-shell[data-viewer-theme] .markdown-body {
  --bgColor-default: var(--card, Canvas);
  --bgColor-muted: var(--muted, ButtonFace);
  --bgColor-neutral-muted: var(--muted, ButtonFace);
  --borderColor-default: var(--border, ButtonBorder);
  --borderColor-muted: var(--border, ButtonBorder);
  --borderColor-neutral-muted: var(--border, ButtonBorder);
  --fgColor-default: var(--card-foreground, CanvasText);
  --fgColor-muted: var(--muted-foreground, GrayText);
  --fgColor-accent: var(--primary, LinkText);
  border-color: var(--border, ButtonBorder);
  box-shadow: none;
}
:host .file-viewer-web-shell[data-viewer-theme] .code-viewer {
  --code-bg: var(--background, Canvas);
  --code-toolbar-bg: var(--muted, ButtonFace);
  --code-border: var(--border, ButtonBorder);
  --code-text: var(--foreground, CanvasText);
  --code-muted: var(--muted-foreground, GrayText);
  --code-accent: var(--primary, Highlight);
  --code-accent-border: var(--border, ButtonBorder);
  --code-accent-soft: var(--accent, ButtonFace);
}
:host .file-viewer-web-shell[data-viewer-theme] :is(.pdf-shell, .pdf-wrapper, .pdf-toolbar, .pdf-nav-pane, .pdf-nav-head, .pdf-nav-tabs, .pdf-state, .pdf-outline-empty) {
  background: var(--background, Canvas);
  color: var(--foreground, CanvasText);
  border-color: var(--border, ButtonBorder);
}
:host .file-viewer-web-shell[data-viewer-theme] :is(.pdf-toolbar-group, .pdf-page-button) {
  background: var(--muted, ButtonFace);
  color: var(--foreground, CanvasText);
  border-color: var(--border, ButtonBorder);
}
:host .file-viewer-web-shell[data-viewer-theme] :is(.pdf-icon-button, .pdf-scale-button, .pdf-page-meter, .pdf-rotation-meter, .pdf-outline-button, .pdf-nav-tabs button, .pdf-nav-head strong, .pdf-page-meter strong) { color: var(--foreground, CanvasText); }
:host .file-viewer-web-shell[data-viewer-theme] :is(.pdf-icon-button, .pdf-scale-button, .pdf-outline-button, .pdf-page-button, .pdf-nav-tabs button):hover,
:host .file-viewer-web-shell[data-viewer-theme] :is(.pdf-icon-button--active, .pdf-page-button--active, .pdf-nav-tabs button.active) {
  background: var(--accent, ButtonFace);
  color: var(--accent-foreground, CanvasText);
  border-color: var(--primary, Highlight);
}
`;
