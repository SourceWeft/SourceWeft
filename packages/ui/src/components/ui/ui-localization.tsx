"use client";

import { createContext, useContext, type ReactNode } from "react";

export type UiMessages = { close: string };
// Standalone consumers keep the existing English default. Applications provide
// their own messages; the shared UI package does not own translated catalogs.
const UiLocalizationContext = createContext<UiMessages>({ close: "Close" });

export function UiLocalizationProvider({
  messages,
  children,
}: {
  messages: UiMessages;
  children: ReactNode;
}) {
  return (
    <UiLocalizationContext.Provider value={messages}>
      {children}
    </UiLocalizationContext.Provider>
  );
}

export function useUiMessages() {
  return useContext(UiLocalizationContext);
}
