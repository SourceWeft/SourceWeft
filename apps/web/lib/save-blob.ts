"use client";

/** Hands a blob to the browser as a download named `fileName`. */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the browser has had the chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
