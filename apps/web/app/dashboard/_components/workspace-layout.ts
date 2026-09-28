/** The narrowest chat canvas a docked panel may leave behind. */
export const MIN_CHAT_WIDTH = 640;

/** All sizes describe the WebView content area in CSS pixels. */
export function resolveWorkspaceLayout(
  width: number,
  conversationPreference = true,
  desktopTitlebar = false,
  conversationRoute = true,
) {
  const mode = width >= 1440 ? "wide" : width >= 1120 ? "standard" : "compact";
  // PC widths keep the navigation rail on every route; phones use the drawer
  // and the bottom navigation instead.
  const railWidth = width >= 768 ? 56 : 0;
  // Keep the menu readable while preserving enough room for the chat canvas.
  const conversationWidth = 280;
  // The conversation list belongs to the chat pages only. There it docks
  // while the chat keeps its minimum width; narrower PC windows slide it out
  // over the chat instead.
  const canDockConversations =
    conversationRoute &&
    railWidth > 0 &&
    width - railWidth - conversationWidth >= MIN_CHAT_WIDTH;
  const conversationsDocked = canDockConversations && conversationPreference;
  const contentWidth = Math.max(
    0,
    width - railWidth - (conversationsDocked ? conversationWidth : 0),
  );
  return {
    mode,
    conversationRoute,
    conversationWidth,
    railWidth,
    // The macOS traffic lights sit over the rail and spill a little past it.
    titlebarInset: desktopTitlebar && !conversationsDocked,
    canDockConversations,
    conversationsDocked,
    contentWidth,
    canDockHub: mode === "wide" && contentWidth - 360 >= MIN_CHAT_WIDTH,
    canDockPreview: mode === "wide" && contentWidth - 480 >= MIN_CHAT_WIDTH,
    previewWidth: Math.min(640, Math.max(0, contentWidth - MIN_CHAT_WIDTH)),
  } as const;
}
