"use client";
import { apiBaseUrl } from "./api-base-url";
import {
  cachedLocalHostHeaders,
  clearLocalHostSession,
} from "./local-host-session";

/** Binary downloads need the same account-bound native proof as directory reads. */
export async function downloadLocalFile(path: string, filename: string) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include",
    cache: "no-store",
    headers: await cachedLocalHostHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    if (error.code === "NATIVE_PROOF_EXPIRED") clearLocalHostSession();
    throw new Error(error.message ?? `Download failed (${response.status})`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
