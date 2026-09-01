"use client";

import type { PresenceViewer } from "./use-thread-presence";

function viewerName(viewer: PresenceViewer): string {
  return viewer.name || (viewer.isGuest ? "A guest" : "Someone");
}

/**
 * "Alice is typing…" shown above the composer. Self is already filtered upstream
 * (server-side and in the presence hook), so this only ever names other viewers.
 */
export function ThreadTypingIndicator({
  typing,
}: {
  typing: PresenceViewer[];
}) {
  const [first, second] = typing;
  if (!first) {
    return null;
  }

  let text: string;
  if (!second) {
    text = `${viewerName(first)} is typing…`;
  } else if (typing.length === 2) {
    text = `${viewerName(first)} and ${viewerName(second)} are typing…`;
  } else {
    text = "Several people are typing…";
  }

  return (
    <div className="px-1 text-xs text-muted-foreground" aria-live="polite">
      {text}
    </div>
  );
}
