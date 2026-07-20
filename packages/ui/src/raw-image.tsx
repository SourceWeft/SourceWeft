import type { ComponentPropsWithoutRef } from "react";

export type RawImageProps = ComponentPropsWithoutRef<"img">;

/**
 * A plain `<img>`. Dynamic and user-provided image URLs are intentionally
 * rendered outside any framework image-optimization pipeline, so every surface
 * that shows a remote asset goes through this one escape hatch.
 */
export function RawImage(props: RawImageProps) {
  return <img {...props} />;
}
