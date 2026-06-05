import {
  SANDBOX_INPUT_ROOT,
  SANDBOX_OUTPUT_ROOT,
  SANDBOX_SKILLS_ROOT,
  SANDBOX_TEMP_ROOT,
  SANDBOX_WORK_ROOT,
  SANDBOX_WORKSPACE_ROOT,
  SOURCEWEFT_KB_ROOT,
  SOURCEWEFT_WORK_ROOT,
} from "./types";

export type SandboxRootPolicy = {
  disallowedVirtualRoots: readonly string[];
  allowedSandboxRoots: readonly string[];
};

export const DEFAULT_SANDBOX_ROOT_POLICY: SandboxRootPolicy = Object.freeze({
  disallowedVirtualRoots: Object.freeze([
    SOURCEWEFT_WORK_ROOT,
    SOURCEWEFT_KB_ROOT,
  ]),
  allowedSandboxRoots: Object.freeze([
    SANDBOX_WORKSPACE_ROOT,
    SANDBOX_SKILLS_ROOT,
    SANDBOX_TEMP_ROOT,
  ]),
});

function normalizePath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const withoutTrailingSlash = absolute.replace(/\/$/g, "");
  return withoutTrailingSlash || "/";
}

function hasControlChars(value: string) {
  return /[\x00-\x1f\x7f]/.test(value);
}

function isRootOrChild(path: string, root: string) {
  const normalizedRoot = normalizePath(root);
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function extractAbsolutePathReferences(command: string) {
  const paths: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  const flush = () => {
    if (current.startsWith("/") && current !== "/") {
      paths.push(current.replace(/[),;]+$/g, ""));
    }
    current = "";
  };

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        flush();
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      flush();
      quote = char;
      continue;
    }
    if (/\s|[;&|<>`$(){}[\],]/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();

  return paths.map(normalizePath);
}

export function assertSourceWorkPath(value: string) {
  const path = normalizePath(value);
  if (
    hasControlChars(path) ||
    !path.startsWith(`${SOURCEWEFT_WORK_ROOT}/`) ||
    path.includes("..") ||
    path.includes("~")
  ) {
    throw new Error("SANDBOX_PREPARE_PATH_DENIED: sourcePath must be under /work/.");
  }
  return path;
}

export function assertPrepareSandboxPath(value: string) {
  const path = normalizePath(value);
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    path.includes("~") ||
    !(path.startsWith(`${SANDBOX_INPUT_ROOT}/`) || path.startsWith(`${SANDBOX_WORK_ROOT}/`))
  ) {
    throw new Error(
      "SANDBOX_PREPARE_PATH_DENIED: sandboxPath must be under /workspace/input/ or /workspace/work/.",
    );
  }
  return path;
}

export function assertCollectSandboxPath(value: string) {
  const path = normalizePath(value);
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    path.includes("~") ||
    !(path.startsWith(`${SANDBOX_OUTPUT_ROOT}/`) || path.startsWith(`${SANDBOX_WORK_ROOT}/`))
  ) {
    throw new Error(
      "SANDBOX_COLLECT_PATH_DENIED: sandboxPath must be under /workspace/output/ or /workspace/work/.",
    );
  }
  return path;
}

export function assertExecuteCwd(value: string | undefined) {
  const path = normalizePath(value || SANDBOX_WORKSPACE_ROOT);
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    path.includes("~") ||
    !(path === SANDBOX_WORKSPACE_ROOT || path.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`))
  ) {
    throw new Error("SANDBOX_EXECUTE_CWD_DENIED: cwd must be under /workspace.");
  }
  return path;
}

export function assertExecuteCommandPathPolicy(
  command: string,
  policy: SandboxRootPolicy = DEFAULT_SANDBOX_ROOT_POLICY,
) {
  if (hasControlChars(command)) {
    throw new Error("SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.");
  }

  for (const path of extractAbsolutePathReferences(command)) {
    if (path.includes("..") || path.includes("~")) {
      throw new Error(
        `SANDBOX_EXECUTE_PATH_DENIED: ${path} contains traversal or home directory expansion. Use paths under ${policy.allowedSandboxRoots.join(", ")}.`,
      );
    }

    if (policy.disallowedVirtualRoots.some((root) => isRootOrChild(path, root))) {
      throw new Error(
        `SANDBOX_EXECUTE_PATH_DENIED: ${path} is a SourceWeft virtual filesystem path and is not mounted in the sandbox. Use sandbox paths under ${policy.allowedSandboxRoots.join(", ")}.`,
      );
    }

    if (!policy.allowedSandboxRoots.some((root) => isRootOrChild(path, root))) {
      throw new Error(
        `SANDBOX_EXECUTE_PATH_DENIED: ${path} is outside allowed sandbox roots. Use paths under ${policy.allowedSandboxRoots.join(", ")}.`,
      );
    }
  }

  return command;
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
