"use client";
import { apiBaseUrl } from "./api-base-url";

export type LocalDevice = { id: string; name: string; online: boolean };
export const LOCAL_TARGET_KEY = "sourceweft.local.execution-target";

export async function localRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      value.message ?? `Local execution request failed (${response.status})`,
    );
  return value as T;
}
