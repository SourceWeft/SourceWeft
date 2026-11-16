import type { SettingsCenterTab } from "./dashboard-settings-center/types";

const DASHBOARD_SETTINGS_OPEN_EVENT = "sourceweft:dashboard-settings-open";

type DashboardSettingsOpenDetail = { tab: SettingsCenterTab };

/**
 * Asks the settings center to open on a section, from code that does not own it. Returns
 * whether something on the page took the request.
 */
export function requestDashboardSettings(tab: SettingsCenterTab) {
  if (typeof window === "undefined") {
    return false;
  }

  return !window.dispatchEvent(
    new CustomEvent<DashboardSettingsOpenDetail>(
      DASHBOARD_SETTINGS_OPEN_EVENT,
      { cancelable: true, detail: { tab } },
    ),
  );
}

/**
 * The listener returns whether it opened the settings center. A request is taken by one
 * listener only: the account menu can be mounted twice, and each owns a settings dialog.
 */
export function subscribeDashboardSettingsOpen(
  listener: (tab: SettingsCenterTab) => boolean,
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleOpen = (event: Event) => {
    if (event.defaultPrevented) return;
    const { tab } = (event as CustomEvent<DashboardSettingsOpenDetail>).detail;
    if (listener(tab)) event.preventDefault();
  };

  window.addEventListener(DASHBOARD_SETTINGS_OPEN_EVENT, handleOpen);

  return () => {
    window.removeEventListener(DASHBOARD_SETTINGS_OPEN_EVENT, handleOpen);
  };
}
