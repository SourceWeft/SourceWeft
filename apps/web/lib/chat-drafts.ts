import type { FileUIPart } from "ai";
export type ChatDraft = {
  text: string;
  files: Array<{
    id: string;
    filename?: string;
    mediaType: string;
    blob: Blob;
  }>;
};
let database: Promise<IDBDatabase> | undefined;
const queues = new Map<string, Promise<void>>();
const fileContents = new WeakMap<object, Promise<Blob>>();
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("sourceweft-chat-drafts", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("drafts"))
        request.result.createObjectStore("drafts");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error ?? new Error("Unable to open draft storage."));
    };
  }));
}
function enqueue<T>(key: string, action: () => Promise<T>): Promise<T> {
  const task = (queues.get(key) ?? Promise.resolve()).then(action);
  const settled = task.then(
    () => {},
    () => {},
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return task;
}
async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", mode);
    const request = action(tx.objectStore("drafts"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? new Error("Unable to save your draft."));
    tx.onabort = () => reject(tx.error ?? new Error("The draft operation was aborted."));
  });
}
export function readChatDraft(key: string): Promise<ChatDraft | null> {
  return enqueue(key, async () => {
    const value = await transact("readonly", (store) => store.get(key));
    if (value === undefined) return null;
    if (
      !value ||
      typeof value.text !== "string" ||
      !Array.isArray(value.files) ||
      value.files.some(
        (file: ChatDraft["files"][number]) =>
          typeof file.id !== "string" ||
          typeof file.mediaType !== "string" ||
          !(file.blob instanceof Blob),
      )
    )
      throw new Error("Draft data is unavailable. Keep this page open and try again.");
    return value as ChatDraft;
  });
}
export function writeChatDraft(
  key: string,
  text: string,
  files: readonly (FileUIPart & { id?: string })[],
): Promise<void> {
  // Capture Blob URLs at intent time, before navigation can revoke them. Keep
  // writes ordered separately, so an older conversion cannot overwrite a newer draft.
  const captured = Promise.all(
    files.map(async (file, index) => {
      if (!file.url.startsWith("blob:") && !file.url.startsWith("data:"))
        throw new Error("This attachment cannot be saved in a local draft.");
      let content = fileContents.get(file);
      if (!content) {
        content = fetch(file.url).then((response) => {
          if (!response.ok) throw new Error("Unable to read the draft attachment.");
          return response.blob();
        });
        fileContents.set(file, content);
      }
      return {
        id: file.id ?? `attachment-${index}`,
        filename: file.filename,
        mediaType: file.mediaType,
        blob: await content,
      };
    }),
  );
  void captured.catch(() => {});
  return enqueue(key, async () => {
    const stored = await captured;
    await transact("readwrite", (store) =>
      store.put({ text, files: stored }, key),
    );
  });
}
export function clearChatDraft(key: string): Promise<void> {
  return enqueue(key, async () => {
    await transact("readwrite", (store) => store.delete(key));
  });
}
