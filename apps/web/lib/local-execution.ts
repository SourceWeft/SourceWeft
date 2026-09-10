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
    cache: "no-store",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(await cachedLocalHostHeaders()),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok && value.code === "NATIVE_PROOF_EXPIRED")
    clearLocalHostSession();
  if (!response.ok) {
    const error = new Error(
      value.message ?? `Local execution request failed (${response.status})`,
    );
    Object.assign(error, { code: value.code, status: response.status });
    throw error;
  }
  return value as T;
}

export type ExecutionInfo = {
  executionTarget:
    | { kind: "cloud" }
    | { kind: "local"; deviceId: string; directoryGrantId?: string };
  workingDirectory: string | null;
  target: { deviceId: string; name: string; online: boolean } | null;
};

export const LOCAL_DIRECTORY_KEY = "sourceweft.local.directory-grant";
export function readDirectorySelection(deviceId: string) {
  const value = sessionStorage.getItem(LOCAL_DIRECTORY_KEY);
  if (!value) return null;
  const parsed = JSON.parse(value) as {
    deviceId: string;
    directoryGrantId: string;
    path: string;
  };
  return parsed.deviceId === deviceId ? parsed : null;
}
