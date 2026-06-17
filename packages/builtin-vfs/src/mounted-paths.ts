import type { FileInfo, FileOperationError } from "deepagents";
import { SKILLS_MOUNT } from "./filesystem-capabilities";
import type { MountedBackend } from "./mounted-types";

export function rootInfo(path: string) {
  return { path: `${path}/`, is_dir: true, size: 0 };
}

export function isMountPath(path: string | null | undefined, mount: string) {
  const value = path || "";
  return value === mount || value.startsWith(`${mount}/`);
}

export function stripMount(path: string, mount: string) {
  if (path === mount) {
    return "/";
  }
  const suffix = path.slice(mount.length);
  return suffix.startsWith("/") ? suffix : `/${suffix}`;
}

export function prefixMount(path: string, mount: string) {
  return `${mount}${path === "/" ? "/" : path}`.replace(/\/+/g, "/");
}

export function delegatePath(path: string, mount: MountedBackend) {
  return mount.capability.root === SKILLS_MOUNT.root
    ? stripMount(path, mount.capability.root)
    : path;
}

export function prefixMountedFiles(
  files: readonly FileInfo[] | undefined,
  mount: string,
) {
  return (files ?? []).map((file) => ({
    ...file,
    path: prefixMount(file.path, mount),
  }));
}

export function fileOperationErrorFromMessage(
  message: string | undefined,
): FileOperationError {
  const normalized = message?.toLowerCase() ?? "";
  if (
    normalized.includes("enoent") ||
    normalized.includes("not found") ||
    normalized.includes("no such file")
  ) {
    return "file_not_found";
  }
  if (normalized.includes("eisdir") || normalized.includes("directory")) {
    return "is_directory";
  }
  if (
    normalized.includes("erofs") ||
    normalized.includes("read-only") ||
    normalized.includes("not allowed")
  ) {
    return "permission_denied";
  }
  return "invalid_path";
}
