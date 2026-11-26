"use client";

import { GoogleTagManager } from "@next/third-parties/google";
import Script from "next/script";
import { useEffect } from "react";

import { thirdPartyTagsAllowedIn, useNativeHost } from "../native-host";
import {
  markDestinationReady,
  startAnalytics,
  type AnalyticsRuntimeConfig,
} from "./client";

/**
 * Loads the script of every analytics tool enabled in the runtime config.
 *
 * Google Tag Manager waits until the host is known and stays out of the iOS
 * app; without its script, entries pushed to the dataLayer are never sent.
 */
export function AnalyticsScripts({
  config,
}: {
  config: AnalyticsRuntimeConfig;
}) {
  const tagManagerAllowed = thirdPartyTagsAllowedIn(useNativeHost());

  useEffect(() => {
    startAnalytics();
  }, []);

  return (
    <>
      {config.gtmId && tagManagerAllowed ? (
        <GoogleTagManager gtmId={config.gtmId} />
      ) : null}
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
