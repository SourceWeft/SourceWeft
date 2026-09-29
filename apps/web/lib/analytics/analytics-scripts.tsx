"use client";

import { GoogleTagManager } from "@next/third-parties/google";
import Script from "next/script";
import { useEffect } from "react";

import {
  markDestinationReady,
  startAnalytics,
  type AnalyticsRuntimeConfig,
} from "./client";

/** Loads the script of every analytics tool enabled in the runtime config. */
export function AnalyticsScripts({
  config,
}: {
  config: AnalyticsRuntimeConfig;
}) {
  useEffect(() => {
    startAnalytics();
  }, []);

  return (
    <>
      {config.gtmId ? <GoogleTagManager gtmId={config.gtmId} /> : null}
      {config.umami ? (
        // Not id="umami": the id would become window.umami, and the tracker
        // then skips installing track/identify, dropping every custom event.
        <Script
          id="umami-script"
          src={config.umami.scriptUrl}
          data-website-id={config.umami.websiteId}
          strategy="afterInteractive"
          onReady={() => markDestinationReady("umami")}
        />
      ) : null}
    </>
  );
}
