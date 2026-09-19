/** All sizes describe the WebView content area in CSS pixels. */
export function resolveWorkspaceLayout(
  width: number,
  conversationPreference = true,
  desktopTitlebar = false,
) {
  const mode = width >= 1440 ? "wide" : width >= 1120 ? "standard" : "compact";
  // Keep the menu readable while preserving enough room for the chat canvas.
  const conversationWidth = 280;
  const canDockConversations = width >= 768;
  const conversationsDocked = canDockConversations && conversationPreference;
  const railWidth =
    canDockConversations && !conversationsDocked && !desktopTitlebar ? 56 : 0;
  const contentWidth = Math.max(
    0,
    width - (conversationsDocked ? conversationWidth : railWidth),
  );
  return {
    mode,
    conversationWidth,
    railWidth,
    canDockConversations,
    conversationsDocked,
    contentWidth,
    canDockHub: mode === "wide" && contentWidth - 360 >= 640,
    canDockPreview: mode === "wide" && contentWidth - 480 >= 640,
    previewWidth: Math.min(640, Math.max(0, contentWidth - 640)),
  } as const;
}
