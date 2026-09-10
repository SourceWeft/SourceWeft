import type { HubSnapshot } from "../app/dashboard/chat/_components/hub-protocol";

export type HubFileRequest = {
  id: string;
  sessionId: string;
  contextKey: string;
  path: string;
  downloadName?: string;
};
export type HubFileResult = {
  id: string;
  sessionId: string;
  contextKey: string;
  chunk?: string;
  index?: number;
  total?: number;
  error?: { message: string; code?: string; status?: number };
};
export type HubFileRequester = (
  path: string,
  downloadName?: string,
) => Promise<unknown>;
let requester: HubFileRequester | undefined;
export function registerHubFileRequester(value: HubFileRequester) {
  requester = value;
  return () => {
    if (requester === value) requester = undefined;
  };
}
export function isHubFileWindow() {
  return (
    typeof window !== "undefined" &&
    window.location.pathname === "/dashboard/hub-window"
  );
}
export function requestHubFile(path: string, downloadName?: string) {
  if (!requester)
    return Promise.reject(
      new Error(
        "Hub is not connected to the main window. Reopen Hub to access this computer's files.",
      ),
    );
  return requester(path, downloadName);
}

export function validateHubFileRequest(
  request: HubFileRequest,
  snapshot: HubSnapshot | null,
) {
  if (
    !snapshot ||
    snapshot.phase !== "active" ||
    request.sessionId !== snapshot.sessionId ||
    request.contextKey !== snapshot.contextKey
  ) {
    throw new Error(
      "The conversation changed. Reopen its Workfiles before continuing.",
    );
  }
  const { workspaceId, threadId } = snapshot.data;
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId ?? "")}/threads/${encodeURIComponent(threadId ?? "")}/local-files`;
  const url = new URL(request.path, "http://hub.invalid");
  if (
    !workspaceId ||
    !threadId ||
    !request.path.startsWith("/") ||
    url.origin !== "http://hub.invalid" ||
    url.pathname !== base ||
    url.hash
  )
    throw new Error("Hub file request is outside the current conversation.");
  const allowed = new Set(["path", "content", "download"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
      throw new Error("Invalid Hub file request.");
  }
  if (
    (url.searchParams.has("content") &&
      url.searchParams.get("content") !== "true") ||
    (url.searchParams.has("download") &&
      url.searchParams.get("download") !== "true") ||
    url.searchParams.has("download") !== (request.downloadName !== undefined) ||
    (url.searchParams.has("download") && url.searchParams.has("content"))
  )
    throw new Error("Invalid Hub file operation.");
  if (
    request.downloadName !== undefined &&
    (!request.downloadName ||
      request.downloadName.length > 255 ||
      /[\\/\0]/.test(request.downloadName))
  )
    throw new Error("Invalid download filename.");
  return snapshot;
}

const CHUNK_SIZE = 64 * 1024;
const MAX_CHUNKS = 512;
/** The main window retains the proof and executes only this thread's file endpoint. */
export async function serveHubFileRequest(
  request: HubFileRequest,
  dependencies: {
    current: () => HubSnapshot | null;
    authorize: (accountId: string) => Promise<unknown>;
    read: (path: string) => Promise<unknown>;
    download: (path: string, name: string) => Promise<void>;
    send: (result: HubFileResult) => Promise<void>;
  },
) {
  const header = {
    id: request.id,
    sessionId: request.sessionId,
    contextKey: request.contextKey,
  };
  try {
    const snapshot = validateHubFileRequest(request, dependencies.current());
    await dependencies.authorize(snapshot.accountId);
    validateHubFileRequest(request, dependencies.current());
    const data =
      request.downloadName !== undefined
        ? await dependencies.download(request.path, request.downloadName)
        : await dependencies.read(request.path);
    validateHubFileRequest(request, dependencies.current());
    const json = JSON.stringify(data ?? null);
    const total = Math.max(1, Math.ceil(json.length / CHUNK_SIZE));
    if (total > MAX_CHUNKS)
      throw new Error(
        "The file response is too large to display in Hub. Download the file instead.",
      );
    for (let index = 0; index < total; index++) {
      validateHubFileRequest(request, dependencies.current());
      await dependencies.send({
        ...header,
        index,
        total,
        chunk: json.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
      });
    }
  } catch (cause) {
    const error = cause as { message?: string; code?: string; status?: number };
    await dependencies.send({
      ...header,
      error: {
        message: error.message ?? "Could not access this computer's files.",
        code: error.code,
        status: error.status,
      },
    });
  }
}

export function createHubFileClient(dependencies: {
  current: () => HubSnapshot | null;
  connected: () => boolean;
  send: (request: HubFileRequest) => Promise<void>;
}) {
  const pending = new Map<
    string,
    {
      request: HubFileRequest;
      parts: string[];
      total?: number;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const cancel = (message: string) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };
  return {
    request(path: string, downloadName?: string): Promise<unknown> {
      const snapshot = dependencies.current();
      if (!snapshot || !dependencies.connected())
        return Promise.reject(
          new Error("Hub is disconnected from the main window."),
        );
      const request = {
        id: crypto.randomUUID(),
        sessionId: snapshot.sessionId,
        contextKey: snapshot.contextKey,
        path,
        downloadName,
      };
      try {
        validateHubFileRequest(request, snapshot);
      } catch (e) {
        return Promise.reject(e);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(
            new Error("The main window did not respond to the file request."),
          );
        }, 60000);
        pending.set(request.id, { request, parts: [], resolve, reject, timer });
        void dependencies.send(request).catch((error) => {
          clearTimeout(timer);
          pending.delete(request.id);
          reject(error);
        });
      });
    },
    receive(result: HubFileResult) {
      const entry = pending.get(result.id);
      if (
        !entry ||
        result.sessionId !== entry.request.sessionId ||
        result.contextKey !== entry.request.contextKey
      )
        return;
      const fail = (error: Error) => {
        clearTimeout(entry.timer);
        pending.delete(result.id);
        entry.reject(error);
      };
      try {
        validateHubFileRequest(entry.request, dependencies.current());
      } catch (e) {
        fail(e as Error);
        return;
      }
      if (result.error) {
        fail(Object.assign(new Error(result.error.message), result.error));
        return;
      }
      const { index, total, chunk } = result;
      if (
        !Number.isInteger(total) ||
        !total ||
        total > MAX_CHUNKS ||
        total < 1 ||
        index !== entry.parts.length ||
        typeof chunk !== "string" ||
        chunk.length > CHUNK_SIZE ||
        (entry.total !== undefined && total !== entry.total)
      ) {
        fail(new Error("Invalid Hub file response."));
        return;
      }
      entry.total = total;
      entry.parts.push(chunk);
      if (entry.parts.length === total) {
        clearTimeout(entry.timer);
        pending.delete(result.id);
        try {
          entry.resolve(JSON.parse(entry.parts.join("")));
        } catch {
          entry.reject(new Error("Invalid Hub file response."));
        }
      }
    },
    cancel,
  };
}
