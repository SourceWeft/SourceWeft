import type { ComponentPropsWithoutRef } from "react";

export type RawImageProps = ComponentPropsWithoutRef<"img">;

export function RawImage(props: RawImageProps) {
  // eslint-disable-next-line @next/next/no-img-element -- Dynamic and user-provided image URLs are intentionally rendered outside Next image optimization.
  return <img {...props} />;
}
