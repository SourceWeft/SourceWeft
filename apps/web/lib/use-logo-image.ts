"use client";

import { useCallback, useState, type SyntheticEvent } from "react";

/** What a loaded logo sits on: white, or dark for light artwork. */
export type LogoBackdrop = "light" | "dark";

export type LogoImageStatus = "none" | "loading" | "loaded" | "failed";

// A pixel is too light to read on white below this contrast ratio. Deliberately
// lenient: a yellow or light-blue mark is still recognizable on white, while
// white and pale-gray artwork is not.
const MIN_CONTRAST_ON_WHITE = 1.5;
// Measure at most this many pixels a side; the verdict does not need more.
const SAMPLE_SIZE = 64;

function linear(channel: number) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The backdrop a logo needs, from its RGBA pixels: dark when it has
 * transparency and most of its visible pixels are too light to read on white.
 * An opaque logo covers its backdrop, so it keeps the default.
 */
export function logoBackdropFor(rgba: ArrayLike<number>): LogoBackdrop {
  let transparent = 0;
  let visible = 0;
  let light = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) {
      transparent++;
      continue;
    }
    visible++;
    const luminance =
      0.2126 * linear(rgba[i]!) +
      0.7152 * linear(rgba[i + 1]!) +
      0.0722 * linear(rgba[i + 2]!);
    if (1.05 / (luminance + 0.05) < MIN_CONTRAST_ON_WHITE) light++;
  }
  return transparent > 0 && light * 2 > visible ? "dark" : "light";
}

/**
 * Reads a loaded data: logo (the thumbnail ingest makes) back through a
 * canvas. Any failure keeps the default backdrop.
 */
function measureBackdrop(image: HTMLImageElement): LogoBackdrop {
  try {
    const width = Math.min(image.naturalWidth, SAMPLE_SIZE);
    const height = Math.min(image.naturalHeight, SAMPLE_SIZE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !width || !height) return "light";
    context.drawImage(image, 0, 0, width, height);
    return logoBackdropFor(context.getImageData(0, 0, width, height).data);
  } catch {
    return "light";
  }
}

type Settled = {
  url: string;
  status: "loaded" | "failed";
  backdrop: LogoBackdrop;
};

/**
 * Load state and backdrop for a logo `<img>`. Spread `imageProps` onto the
 * image, and give it `key={url}` so a new logo gets a new element.
 *
 * A server-rendered image can finish loading or fail before hydration
 * attaches `onLoad`/`onError`, and React does not replay those events, so the
 * ref also settles an image that is already complete when it attaches.
 */
export function useLogoImage(url: string | null | undefined) {
  const [settled, setSettled] = useState<Settled | null>(null);
  const settle = useCallback(
    (image: HTMLImageElement, loaded: boolean) => {
      if (!url) return;
      // Only a data: logo can be read back; a remote one taints the canvas.
      const next: Settled = loaded
        ? {
            url,
            status: "loaded",
            backdrop: url.startsWith("data:")
              ? measureBackdrop(image)
              : "light",
          }
        : { url, status: "failed", backdrop: "light" };
      setSettled((previous) =>
        previous?.url === next.url &&
        previous.status === next.status &&
        previous.backdrop === next.backdrop
          ? previous
          : next,
      );
    },
    [url],
  );
  const ref = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image?.complete) return;
      if (image.naturalWidth > 0) return settle(image, true);
      // Broken, or an SVG without an intrinsic size: decoding tells them apart.
      image.decode().then(
        () => settle(image, true),
        () => settle(image, false),
      );
    },
    [settle],
  );
  const current = url && settled?.url === url ? settled : null;
  const status: LogoImageStatus = !url
    ? "none"
    : (current?.status ?? "loading");
  return {
    status,
    backdrop: current?.backdrop ?? "light",
    imageProps: {
      ref,
      onLoad: (event: SyntheticEvent<HTMLImageElement>) =>
        settle(event.currentTarget, true),
      onError: (event: SyntheticEvent<HTMLImageElement>) =>
        settle(event.currentTarget, false),
    },
  };
}
