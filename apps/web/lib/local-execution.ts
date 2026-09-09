"use client";
import { apiBaseUrl } from "./api-base-url";
import {
  cachedLocalHostHeaders,
  clearLocalHostSession,
} from "./local-host-session";

export type LocalDevice = {
  id: string;
  name: string;
  online: boolean;
  remoteEnabled: boolean;
  connected: boolean;
};

export async function localRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(await cachedLocalHostHeaders()),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok && value.code === "NATIVE_PROOF_EXPIRED")
    clearLocalHostSession();
  if (!response.ok)
    throw new Error(
      value.message ?? `Local execution request failed (${response.status})`,
    );
  return value as T;
}
