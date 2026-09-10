"use client";

import {
  MAX_PREVIEW_BYTES,
  readPreviewBlob,
  type PreviewSource,
} from "@sourceweft/preview";
import { authClient } from "./auth-client";
import { getNativeBridge } from "./native-bridge";

export type DesktopPreviewFile = {
  id: string;
  accountId: string;
  name: string;
  description: string;
  mimeType: string;
  base64: string;
};

async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const bridge = window.__SOURCEWEFT_DESKTOP__ ?? getNativeBridge();
  if (!bridge || ("kind" in bridge && bridge.kind !== "desktop"))
    throw new Error("The desktop preview bridge is unavailable.");
  try {
    return await bridge.invoke<T>(command, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function openDesktopPreview(
  source: PreviewSource,
  description: string,
  signal: AbortSignal,
) {
  const { data: session } = await authClient.getSession();
  if (!session?.user.id)
    throw new Error("Sign in before opening a file preview.");
  const blob =
    source.blob ??
    (source.text !== undefined
      ? new Blob([source.text], { type: source.mimeType ?? "text/plain" })
      : await readPreviewBlob(
          await fetch(source.url!, { credentials: "same-origin", signal }),
          signal,
        ));
  if (blob.size > MAX_PREVIEW_BYTES)
    throw new Error("This file exceeds the 32 MB preview limit.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  signal.throwIfAborted();
  const file: DesktopPreviewFile = {
    id: crypto.randomUUID(),
    accountId: session.user.id,
    name: source.name,
    description,
    mimeType: source.mimeType || blob.type,
    base64: btoa(binary),
  };
  await invoke<void>("open_file_preview", { file });
}

export const desktopPreviewBridge = {
  read: (id: string) => invoke<DesktopPreviewFile>("read_file_preview", { id }),
  close: () => invoke<void>("close_file_preview"),
};
