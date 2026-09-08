/**
 * Cross-tree signal: a running turn projected a `task` delegate into a child
 * thread, so the sidebar should show it under its parent. The stream handlers
 * cannot reach the dashboard state directly (they only get their own context),
 * so this mirrors the billing-summary refresh channel on `window`.
 */
const DASHBOARD_CHAT_CHILD_REFRESH_EVENT = "sourceweft:chat-child-refresh";

export type DashboardChatChildRefreshDetail = {
  /** The child thread to fetch and nest under its parent. */
  childThreadId: string;
};

export function dispatchDashboardChatChildRefresh(
  detail: DashboardChatChildRefreshDetail,
) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DashboardChatChildRefreshDetail>(
      DASHBOARD_CHAT_CHILD_REFRESH_EVENT,
      { detail },
    ),
  );
}

export function subscribeDashboardChatChildRefresh(
  listener: (detail: DashboardChatChildRefreshDetail | undefined) => void,
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleRefresh = (event: Event) => {
    listener((event as CustomEvent<DashboardChatChildRefreshDetail>).detail);
  };

  window.addEventListener(DASHBOARD_CHAT_CHILD_REFRESH_EVENT, handleRefresh);

  return () => {
    window.removeEventListener(
      DASHBOARD_CHAT_CHILD_REFRESH_EVENT,
      handleRefresh,
    );
  };
}
