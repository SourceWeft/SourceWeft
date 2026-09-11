"use client";
import { isHubFileWindow, requestHubFile } from "./hub-file-relay";
import { apiBaseUrl } from "./api-base-url";
import { reportLocalAvailabilityError } from "./local-availability-events";
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

export type LocalRequestOptions = {
  /** Override the path policy when the endpoint needs native authorization. */
  localProof?: boolean;
};

export async function localRequest<T>(
  path: string,
  body?: unknown,
  options?: LocalRequestOptions,
): Promise<T> {
  if (
    isHubFileWindow() &&
    /\/(?:local-files|local-execution)(?:\?|$)/.test(path)
  ) {
    if (body !== undefined)
      throw new Error("Hub file relay supports reads and downloads only.");
    return (await requestHubFile(path)) as T;
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    cache: "no-store",
    signal: path.endsWith("/local-execution")
      ? AbortSignal.timeout(10000)
      : undefined,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options?.localProof === false
        ? {}
        : await cachedLocalHostHeaders(
            options?.localProof === true ? undefined : path,
          )),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error) => {
    if (!path.endsWith("/local-execution"))
      reportLocalAvailabilityError(path, error);
    throw error;
  });
  const value = await response.json();
  if (
    (!response.ok && value.code === "NATIVE_PROOF_EXPIRED") ||
    (path.endsWith("/local-execution") &&
      value.availability?.code === "NATIVE_PROOF_EXPIRED")
  )
    clearLocalHostSession();
  if (!response.ok) {
    const error = new Error(
      value.message ?? `Local execution request failed (${response.status})`,
    );
    Object.assign(error, { code: value.code, status: response.status });
    if (!path.endsWith("/local-execution"))
      reportLocalAvailabilityError(path, error);
    throw error;
  }
  return value as T;
}

export type ExecutionInfo = {
  availability?: {
    ready: boolean;
    code: string | null;
    message: string | null;
  };
  executionTarget: import("@sourceweft/contracts").ThreadExecutionTarget;
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
