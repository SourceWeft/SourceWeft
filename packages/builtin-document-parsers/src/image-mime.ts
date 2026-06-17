export const imageMimeTypes = [
  "image/avif",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/tiff",
  "image/bmp",
  "image/gif",
] as const;

export function isSupportedImageMimeType(mimeType: string) {
  return imageMimeTypes.includes(
    mimeType.toLowerCase() as (typeof imageMimeTypes)[number],
  );
}
