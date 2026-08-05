import {
  SOURCEWEFT_KB_ROOT,
  SOURCEWEFT_SKILLS_ROOT,
  SOURCEWEFT_WORK_ROOT,
  type SandboxProviderPathPolicy,
} from "./types";

export type SandboxRootPolicy = {
  disallowedVirtualRoots: readonly string[];
  allowedSandboxRoots: readonly string[];
};

export const SOURCEWEFT_VFS_ROOT_POLICY: SandboxRootPolicy = Object.freeze({
  disallowedVirtualRoots: Object.freeze([
    SOURCEWEFT_WORK_ROOT,
    SOURCEWEFT_KB_ROOT,
    SOURCEWEFT_SKILLS_ROOT,
  ]),
  allowedSandboxRoots: Object.freeze([]),
});

/**
 * Roots that execute commands may never reference, independent of skill
 * staging: these are DB-backed VFS namespaces with no sandbox counterpart.
 * /skills is deliberately absent — when staging resolved, it is a real
 * sandbox directory holding byte-identical copies of the bundle content
 * (docs/architecture/sandbox-skill-staging.md, D2). Path-level asserts
 * below keep using SOURCEWEFT_VFS_ROOT_POLICY, so cwd/prepare/collect
 * still treat /skills as platform-owned and read-only.
 */
const EXECUTE_ALWAYS_DENIED_ROOTS = Object.freeze([
  SOURCEWEFT_WORK_ROOT,
  SOURCEWEFT_KB_ROOT,
]);

function normalizePath(value: string) {
  if (hasControlChars(value)) {
    return value;
  }
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const withoutTrailingSlash = absolute.replace(/\/$/g, "");
  return withoutTrailingSlash || "/";
}

function hasControlChars(value: string) {
  return /[\x00-\x1f\x7f]/.test(value);
}

function hasDisallowedCommandControlChars(value: string) {
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value);
}

function disallowedExecuteVfsRoot(
  command: string,
  options: { skillScriptsStaged?: boolean } = {},
) {
  const roots = options.skillScriptsStaged
    ? EXECUTE_ALWAYS_DENIED_ROOTS
    : SOURCEWEFT_VFS_ROOT_POLICY.disallowedVirtualRoots;
  return roots.find((root) => command.includes(root));
}

function isRootOrChild(path: string, root: string) {
  const normalizedRoot = normalizePath(root);
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

export function assertSourceWorkPath(value: string) {
  const path = normalizePath(value);
  if (
    hasControlChars(path) ||
    !path.startsWith(`${SOURCEWEFT_WORK_ROOT}/`) ||
    path.includes("..") ||
    path.includes("~")
  ) {
    throw new Error(
      `SANDBOX_PREPARE_PATH_DENIED: sourcePath must be a SourceWeft DB-backed ${SOURCEWEFT_WORK_ROOT}/... Workfile path.`,
    );
  }
  return path;
}

function formatRoots(roots: readonly string[]) {
  return roots.map(normalizePath).join(", ");
}

function policyRoots(input: {
  policy: SandboxProviderPathPolicy;
  kind: keyof Pick<
    SandboxProviderPathPolicy,
    | "prepareTargetRoots"
    | "collectSourceRoots"
    | "readWriteRoots"
  >;
}) {
  return input.policy[input.kind].map(normalizePath);
}

function assertProviderSandboxPath(input: {
  value: string;
  roots: readonly string[];
  code: string;
  description: string;
}) {
  const path = normalizePath(input.value);
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    path.includes("~") ||
    !input.roots.some((root) => isRootOrChild(path, root))
  ) {
    throw new Error(
      `${input.code}: ${input.description} must be under ${formatRoots(input.roots)}.`,
    );
  }
  return path;
}

function assertNotSourceWeftVfsPath(path: string, code: string) {
  if (
    SOURCEWEFT_VFS_ROOT_POLICY.disallowedVirtualRoots.some((root) =>
      isRootOrChild(path, root),
    )
  ) {
    throw new Error(
      `${code}: ${path} is a SourceWeft DB-backed VFS logical path, not a sandbox filesystem path.`,
    );
  }
}

function assertSandboxPathForPolicy(input: {
  value: string;
  policy: SandboxProviderPathPolicy;
  kind: keyof Pick<
    SandboxProviderPathPolicy,
    | "prepareTargetRoots"
    | "collectSourceRoots"
    | "readWriteRoots"
  >;
  code: string;
  description: string;
}) {
  const path = normalizePath(input.value);
  assertNotSourceWeftVfsPath(path, input.code);
  return assertProviderSandboxPath({
    value: path,
    roots: policyRoots({ policy: input.policy, kind: input.kind }),
    code: input.code,
    description: input.description,
  });
}

export function assertPrepareSandboxPath(
  value: string,
  policy: SandboxProviderPathPolicy,
) {
  return assertSandboxPathForPolicy({
    value,
    policy,
    kind: "prepareTargetRoots",
    code: "SANDBOX_PREPARE_PATH_DENIED",
    description: "sandboxPath",
  });
}

export function assertCollectSandboxPath(
  value: string,
  policy: SandboxProviderPathPolicy,
) {
  return assertSandboxPathForPolicy({
    value,
    policy,
    kind: "collectSourceRoots",
    code: "SANDBOX_COLLECT_PATH_DENIED",
    description: "sandboxPath",
  });
}

export function assertSandboxFilePath(
  value: string,
  policy: SandboxProviderPathPolicy,
) {
  const path = normalizePath(value);
  if (hasControlChars(path) || path.includes("..") || path.includes("~")) {
    throw new Error(
      `SANDBOX_FILE_PATH_DENIED: path must be under ${formatRoots(policy.readWriteRoots)}.`,
    );
  }
  assertNotSourceWeftVfsPath(path, "SANDBOX_FILE_PATH_DENIED");
  if (
    !policy.readWriteRoots
      .map(normalizePath)
      .some((root) => isRootOrChild(path, root))
  ) {
    throw new Error(
      `SANDBOX_FILE_PATH_DENIED: ${path} is outside allowed sandbox roots. Use paths under ${formatRoots(policy.readWriteRoots)}.`,
    );
  }
  return path;
}

export function assertExecuteCwd(
  value: string | undefined,
  policy: SandboxProviderPathPolicy,
) {
  const path = normalizePath(value || policy.defaultCwd);
  assertNotSourceWeftVfsPath(path, "SANDBOX_EXECUTE_CWD_DENIED");
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    path.includes("~") ||
    !isRootOrChild(path, policy.workspaceRoot)
  ) {
    throw new Error(
      `SANDBOX_EXECUTE_CWD_DENIED: cwd must be under ${normalizePath(policy.workspaceRoot)}.`,
    );
  }
  return path;
}

export function assertSandboxReadPath(
  value: string,
  policy: SandboxProviderPathPolicy,
) {
  const path = normalizePath(value);
  assertNotSourceWeftVfsPath(path, "SANDBOX_READ_PATH_DENIED");
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    path.includes("~") ||
    !policy.readWriteRoots
      .map(normalizePath)
      .some((root) => isRootOrChild(path, root))
  ) {
    throw new Error(
      `SANDBOX_READ_PATH_DENIED: path must be under ${formatRoots(policy.readWriteRoots)}.`,
    );
  }
  return path;
}

export function assertSandboxWritePath(
  value: string,
  policy: SandboxProviderPathPolicy,
) {
  return assertSandboxReadPath(value, policy);
}

export function assertExecuteCommandPathPolicy(
  command: string,
  options: { skillScriptsStaged?: boolean } = {},
) {
  if (!command.trim()) {
    throw new Error("SANDBOX_EXECUTE_COMMAND_DENIED: command is empty.");
  }
  if (hasDisallowedCommandControlChars(command)) {
    throw new Error(
      "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
    );
  }
  const vfsRoot = disallowedExecuteVfsRoot(command, options);
  if (vfsRoot) {
    const accessibleRoots = options.skillScriptsStaged
      ? `${SOURCEWEFT_WORK_ROOT}, ${SOURCEWEFT_KB_ROOT}`
      : `${SOURCEWEFT_WORK_ROOT}, ${SOURCEWEFT_KB_ROOT}, ${SOURCEWEFT_SKILLS_ROOT}`;
    throw new Error(
      `SANDBOX_EXECUTE_VFS_PATH_DENIED: execute commands must not include SourceWeft VFS logical path ${vfsRoot}. SourceWeft VFS roots (${accessibleRoots}) must be accessed with SourceWeft file or source tools. Use prepare_sandbox_workspace to materialize selected files under /workspace. Use only /workspace/... paths inside execute.`,
    );
  }
  return command;
}

/**
 * True when the command references the /skills contract root — the signal the
 * execute path uses to defer the final policy check until skill staging has
 * resolved for the sandbox (two-phase check: /workfiles and /kb fail fast,
 * /skills-referencing commands are re-asserted with the staging outcome).
 */
export function commandReferencesSkillsRoot(command: string) {
  return command.includes(SOURCEWEFT_SKILLS_ROOT);
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
