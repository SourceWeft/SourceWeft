"use client";
import { readPreviewBlob } from "@sourceweft/preview";
import { apiBaseUrl } from "./api-base-url";
import { reportLocalAvailabilityError } from "./local-availability-events";
import {
  cachedLocalHostHeaders,
  clearLocalHostSession,
} from "./local-host-session";
import { isHubFileWindow, requestHubFile } from "./hub-file-relay";

export async function readLocalPreviewBlob(
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (isHubFileWindow()) {
    const data = (await requestHubFile(path, undefined, true)) as {
      base64: string;
      mimeType: string;
    };
    signal?.throwIfAborted();
    return new Blob(
      [Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))],
      { type: data.mimeType },
    );
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include",
    cache: "no-store",
    signal,
    headers: await cachedLocalHostHeaders(path),
  }).catch((error) => {
    reportLocalAvailabilityError(path, error);
    throw error;
  });
  if (!response.ok) {
    const error = await response.json();
    if (error.code === "NATIVE_PROOF_EXPIRED") clearLocalHostSession();
    reportLocalAvailabilityError(path, error);
    throw Object.assign(
      new Error(error.message ?? `Could not read file (${response.status}).`),
      { code: error.code },
    );
  }
  return readPreviewBlob(response, signal);
}

/** Only the authorized main window reads binary data; Hub receives bounded chunks. */
export async function readLocalPreviewForHub(path: string) {
  const blob = await readLocalPreviewBlob(path);
  // The existing relay caps JSON at 32 MiB, allowing 24 MiB before base64 overhead.
  if (blob.size > 23 * 1024 * 1024)
    throw new Error(
      "This file exceeds the Hub preview limit. Download it to open it.",
    );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return { base64: btoa(binary), mimeType: blob.type };
}
