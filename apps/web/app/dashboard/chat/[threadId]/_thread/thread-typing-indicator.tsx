"use client";

import { useTranslations } from "next-intl";
import type { PresenceViewer } from "./use-thread-presence";

/**
 * "Alice is typing…" shown above the composer. Self is already filtered upstream
 * (server-side and in the presence hook), so this only ever names other viewers.
 */
export function ThreadTypingIndicator({
  typing,
}: {
  typing: PresenceViewer[];
}) {
  const t = useTranslations("dashboardChat");
  const viewerName = (viewer: PresenceViewer): string =>
    viewer.name || (viewer.isGuest ? t("typing.guest") : t("typing.someone"));
  const [first, second] = typing;
  if (!first) {
    return null;
  }

  let text: string;
  if (!second) {
    text = t("typing.one", { name: viewerName(first) });
  } else if (typing.length === 2) {
    text = t("typing.two", {
      first: viewerName(first),
      second: viewerName(second),
    });
  } else {
    text = t("typing.several");
  }

  return (
    <div className="px-1 text-xs text-muted-foreground" aria-live="polite">
      {text}
    </div>
  );
}
