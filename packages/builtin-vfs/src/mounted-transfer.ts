import type {
  BackendProtocolV2,
  FileDownloadResponse,
  FileOperationError,
  FileUploadResponse,
} from "deepagents";
import { delegatePath, fileOperationErrorFromMessage } from "./mounted-paths";
import type { MountedBackend } from "./mounted-types";

type DownloadBatchItem = {
  readonly index: number;
  readonly path: string;
  readonly originalPath: string;
};

type UploadBatchItem = DownloadBatchItem & {
  readonly content: Uint8Array;
};

export function downloadError(
  path: string,
  error: FileOperationError,
): FileDownloadResponse {
  return { path, content: null, error };
}

export function uploadError(
  path: string,
  error: FileOperationError,
): FileUploadResponse {
  return { path, error };
}

export async function downloadMountedFiles(input: {
  readonly paths: readonly string[];
  readonly mounts: readonly MountedBackend[];
  readonly route: (path: string) => MountedBackend | null;
}): Promise<FileDownloadResponse[]> {
  const results = Array.from(
    { length: input.paths.length },
    () => null as FileDownloadResponse | null,
  );
  const batches = new Map<BackendProtocolV2, DownloadBatchItem[]>();

  input.paths.forEach((path, index) => {
    const mount = input.route(path);
    if (!mount) {
      results[index] = downloadError(path, "invalid_path");
      return;
    }
    const routedPath = delegatePath(path, mount);
    const batch = batches.get(mount.backend) ?? [];
    batch.push({ index, path: routedPath, originalPath: path });
    batches.set(mount.backend, batch);
  });

  const encoder = new TextEncoder();
  for (const [backend, batch] of batches) {
    const mount = input.mounts.find((item) => item.backend === backend);
    if (mount?.capability.citable) {
      batch.forEach((item) => {
        results[item.index] = downloadError(
          item.originalPath,
          "permission_denied",
        );
      });
      continue;
    }

    if (backend.downloadFiles) {
      const responses = await backend.downloadFiles(
        batch.map((item) => item.path),
      );
      batch.forEach((item, batchIndex) => {
        const response = responses[batchIndex];
        results[item.index] = {
          path: item.originalPath,
          content: response?.content ?? null,
          error: response?.error ?? "file_not_found",
        };
      });
      continue;
    }

    await Promise.all(
      batch.map(async (item) => {
        const raw = await backend.readRaw(item.path);
        if (raw.error || !raw.data) {
          results[item.index] = downloadError(
            item.originalPath,
            fileOperationErrorFromMessage(raw.error),
          );
          return;
        }
        const content = raw.data.content;
        const text = Array.isArray(content) ? content.join("\n") : content;
        results[item.index] = {
          path: item.originalPath,
          content: typeof text === "string" ? encoder.encode(text) : text,
          error: null,
        };
      }),
    );
  }

  return results.map(
    (result, index) =>
      result ?? downloadError(input.paths[index] ?? "", "invalid_path"),
  );
}

export async function uploadMountedFiles(input: {
  readonly files: readonly [string, Uint8Array][];
  readonly writableRoute: (path: string) => MountedBackend | undefined;
}): Promise<FileUploadResponse[]> {
  const results = Array.from(
    { length: input.files.length },
    () => null as FileUploadResponse | null,
  );
  const batches = new Map<BackendProtocolV2, UploadBatchItem[]>();

  input.files.forEach(([path, content], index) => {
    const mount = input.writableRoute(path);
    if (!mount) {
      results[index] = uploadError(path, "permission_denied");
      return;
    }
    const routedPath = delegatePath(path, mount);
    const batch = batches.get(mount.backend) ?? [];
    batch.push({ index, path: routedPath, originalPath: path, content });
    batches.set(mount.backend, batch);
  });

  const decoder = new TextDecoder();
  for (const [backend, batch] of batches) {
    if (backend.uploadFiles) {
      const responses = await backend.uploadFiles(
        batch.map((item) => [item.path, item.content]),
      );
      batch.forEach((item, batchIndex) => {
        const response = responses[batchIndex];
        results[item.index] = {
          path: item.originalPath,
          error: response?.error ?? null,
        };
      });
      continue;
    }

    await Promise.all(
      batch.map(async (item) => {
        const write = await backend.write(
          item.path,
          decoder.decode(item.content),
        );
        results[item.index] = write.error
          ? uploadError(
              item.originalPath,
              fileOperationErrorFromMessage(write.error),
            )
          : { path: item.originalPath, error: null };
      }),
    );
  }

  return results.map(
    (result, index) =>
      result ?? uploadError(input.files[index]?.[0] ?? "", "invalid_path"),
  );
}
