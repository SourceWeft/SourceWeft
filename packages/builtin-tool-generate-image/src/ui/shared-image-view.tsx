"use client";

import { useState } from "react";
import { RawImage } from "@sourceweft/ui-web/raw-image";

/**
 * Full-page image viewer for the public share surface.
 *
 * Default is fit-to-screen: the whole image, one screen, no scroll — the way a
 * single image reads best. Click toggles zoom to natural size, which scrolls
 * (and pans) for detail — the escape hatch for tall infographics or fine print.
 * Kept deliberately minimal (no chrome) so the image is the page.
 */
export function SharedImageView({ alt, src }: { alt: string; src: string }) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <div
      className={`h-full w-full ${zoomed ? "overflow-auto" : "overflow-hidden"}`}
    >
      <div
        className={`flex ${
          zoomed ? "min-h-full" : "h-full"
        } items-center justify-center p-4 sm:p-6`}
      >
        <RawImage
          alt={alt}
          className={
            zoomed
              ? "h-auto w-auto max-w-full cursor-zoom-out"
              : "max-h-full max-w-full cursor-zoom-in object-contain"
          }
          onClick={() => setZoomed((current) => !current)}
          src={src}
          title={zoomed ? "Click to fit" : "Click to zoom"}
        />
      </div>
    </div>
  );
}
