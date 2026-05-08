import { ContentError } from "../errors";

export const WORK_ROOT = "/work";

export function normalizeWorkingFilePath(path: string | undefined | null) {
  const raw = typeof path === "string" ? path.trim() : "";
  if (!raw) {
    throw new ContentError(400, "INVALID_WORKING_FILE_PATH", "path is required");
  }

  const withRoot = raw.startsWith("/") ? raw : `${WORK_ROOT}/${raw}`;
  const normalized = withRoot.replace(/\/+/g, "/").replace(/\/$/, "");

  if (normalized === WORK_ROOT || normalized === "/") {
    throw new ContentError(
      400,
      "INVALID_WORKING_FILE_PATH",
      "path must point to a file under /work",
    );
  }

  if (!normalized.startsWith(`${WORK_ROOT}/`)) {
    throw new ContentError(
      400,
      "INVALID_WORKING_FILE_PATH",
      `working files only expose /work, got '${raw}'`,
    );
  }

  if (
    normalized.includes("..") ||
    normalized.includes("~") ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ContentError(
      400,
      "INVALID_WORKING_FILE_PATH",
      `invalid working file path '${raw}'`,
    );
  }

  return normalized;
}

export function normalizeWorkingFsPath(path: string | undefined | null) {
  const raw = typeof path === "string" && path.trim().length > 0
    ? path.trim()
    : WORK_ROOT;
  const withRoot = raw.startsWith("/") ? raw : `/${raw}`;
  const normalized = withRoot.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

  if (normalized.includes("..") || normalized.includes("~")) {
    throw new ContentError(
      400,
      "INVALID_WORKING_FILE_PATH",
      `invalid working file path '${raw}'`,
    );
  }

  if (normalized !== "/" && normalized !== WORK_ROOT && !normalized.startsWith(`${WORK_ROOT}/`)) {
    throw new ContentError(
      400,
      "INVALID_WORKING_FILE_PATH",
      `working files only expose /work, got '${raw}'`,
    );
  }

  return normalized;
}

export function parentWorkingDirectory(path: string) {
  const normalized = normalizeWorkingFilePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= WORK_ROOT.length ? WORK_ROOT : normalized.slice(0, index);
}

export function basename(path: string) {
  const normalized = normalizeWorkingFilePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
