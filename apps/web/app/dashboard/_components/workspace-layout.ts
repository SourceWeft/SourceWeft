/** All sizes describe the WebView content area in CSS pixels. */
export function resolveWorkspaceLayout(
  width: number,
  conversationPreference = true,
) {
  const mode = width >= 1440 ? "wide" : width >= 1120 ? "standard" : "compact";
  const railWidth = width >= 768 ? 56 : 0;
  const conversationWidth = mode === "wide" ? 256 : 240;
  const canDockConversations = width >= 1120;
  const conversationsDocked = canDockConversations && conversationPreference;
  const contentWidth = Math.max(
    0,
    width - railWidth - (conversationsDocked ? conversationWidth : 0),
  );
  return {
    mode,
    conversationWidth,
    canDockConversations,
    conversationsDocked,
    contentWidth,
    canDockHub: mode === "wide" && contentWidth - 360 >= 640,
    canDockPreview: mode === "wide" && contentWidth - 480 >= 640,
    previewWidth: Math.min(640, Math.max(0, contentWidth - 640)),
  } as const;
}
