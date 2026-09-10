"use client";

import { useSyncExternalStore } from "react";
import { desktopBridge } from "./desktop-bridge";

const subscribe = () => () => {};
const getServerSnapshot = () => false;
const getSnapshot = () =>
  window.__SOURCEWEFT_TITLEBAR_OVERLAY__ === true &&
  desktopBridge.isAvailable();

/** The native window sets this immutable flag; user-agent sniffing is insufficient. */
export function useDesktopTitlebar() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function isTitlebarDragTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest("[data-desktop-drag-region]")) &&
    !target.closest(
      'button, a, input, textarea, select, [tabindex], [role="button"], [role="combobox"], [role="menu"], [role="listbox"], [role="dialog"], [contenteditable]:not([contenteditable="false"]), [data-desktop-no-drag]',
    )
  );
}
