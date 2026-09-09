"use client";
import { getNativeBridge } from "./native-bridge";
import type { HubMessage } from "../app/dashboard/chat/_components/hub-protocol";
import { HUB_EVENT } from "../app/dashboard/chat/_components/hub-protocol";

function bridge() {
  const value =
    typeof window === "undefined"
      ? undefined
      : (window.__SOURCEWEFT_DESKTOP__ ?? getNativeBridge());
  if (!value || ("kind" in value && value.kind !== "desktop"))
    throw new Error("The desktop Hub bridge is unavailable.");
  return value;
}
export const desktopHubBridge = {
  action(
    action:
      | "open"
      | "focus"
      | "abort"
      | "logout"
      | "show"
      | "close"
      | "docked"
      | "main",
  ) {
    return bridge().invoke<void>("hub_window_action", { action });
  },
  send(message: HubMessage) {
    return bridge().invoke<void>("hub_window_send", { message });
  },
  listen(handler: (message: HubMessage) => void) {
    return bridge().listen<HubMessage>(HUB_EVENT, (event) =>
      handler(event.payload),
    );
  },
};
