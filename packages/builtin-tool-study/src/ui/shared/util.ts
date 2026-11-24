import type { KeyboardEvent } from "react";

/** A file name stem from a title: path- and control-safe, never empty. */
export function downloadStem(title: string | null | undefined, fallback: string) {
  const stem = (title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return stem || fallback;
}

/** Shortcut keys belong to the viewer only when the user is not typing or chording. */
export function isViewerShortcut(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  return !(tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable);
}
