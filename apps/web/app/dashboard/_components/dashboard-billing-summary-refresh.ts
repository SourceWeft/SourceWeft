const DASHBOARD_BILLING_SUMMARY_REFRESH_EVENT =
  "sourceweft:billing-summary-refresh";

export type DashboardBillingSummaryRefreshDetail = {
  reason: "chat-turn-terminal";
};

export function dispatchDashboardBillingSummaryRefresh(
  detail: DashboardBillingSummaryRefreshDetail,
) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DashboardBillingSummaryRefreshDetail>(
      DASHBOARD_BILLING_SUMMARY_REFRESH_EVENT,
      { detail },
    ),
  );
}

export function subscribeDashboardBillingSummaryRefresh(
  listener: (detail: DashboardBillingSummaryRefreshDetail | undefined) => void,
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleRefresh = (event: Event) => {
    listener(
      (event as CustomEvent<DashboardBillingSummaryRefreshDetail>).detail,
    );
  };

  window.addEventListener(
    DASHBOARD_BILLING_SUMMARY_REFRESH_EVENT,
    handleRefresh,
  );

  return () => {
    window.removeEventListener(
      DASHBOARD_BILLING_SUMMARY_REFRESH_EVENT,
      handleRefresh,
    );
  };
}
