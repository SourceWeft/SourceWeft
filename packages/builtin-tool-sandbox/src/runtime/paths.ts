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

/**
 * A Windows device speaks forward-slash drive paths (`C:/Users/me/...`) on the
 * wire. This matches only that shape; `C:foo` (drive-relative), `//server` and
 * `\\?\` prefixes are not drive-absolute and stay rejectable.
 */
const DRIVE_ABSOLUTE = /^[A-Za-z]:(?:\/|$)/u;

export function isDriveAbsolutePath(path: string) {
  return DRIVE_ABSOLUTE.test(path);
}

/**
 * True when the provider's roots are drive paths. Drive awareness is driven by
 * the policy so a POSIX policy keeps its exact historical behaviour: an input
 * such as `C:/x` is only understood as a drive path under a drive-rooted
 * policy, and is otherwise treated as it always was.
 */
export function policyUsesDrivePaths(policy: SandboxProviderPathPolicy) {
  return [
    policy.workspaceRoot,
    policy.defaultCwd,
    ...policy.readWriteRoots,
    ...policy.prepareTargetRoots,
    ...policy.collectSourceRoots,
  ].some((root) => typeof root === "string" && isDriveAbsolutePath(root));
}

/**
 * Canonical form of a model- or host-supplied sandbox path: `/`-separated, no
 * duplicate or trailing slash. With `driveAware`, a drive-absolute path keeps
 * its drive (upper-cased letter, `C:/` for the drive root) instead of being
 * rooted at `/`.
 */
export function normalizeSandboxPath(value: string, driveAware = false) {
  if (hasControlChars(value)) {
    return value;
  }
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (driveAware && DRIVE_ABSOLUTE.test(normalized)) {
    const rest = normalized.slice(2).replace(/\/$/g, "");
    return `${normalized.charAt(0).toUpperCase()}:${rest || "/"}`;
  }
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const withoutTrailingSlash = absolute.replace(/\/$/g, "");
  return withoutTrailingSlash || "/";
}

function normalizePath(value: string) {
  return normalizeSandboxPath(value, false);
}

/**
 * `~` expands to a home directory only at the start of a word. In a POSIX path
 * any `~` is refused, as before. In a drive path a mid-name `~` is an ordinary
 * 8.3 short-name character (`RUNNER~1`), so only a component that starts with
 * it is refused.
 */
function hasHomeExpansion(path: string) {
  return isDriveAbsolutePath(path)
    ? path.split("/").some((part) => part.startsWith("~"))
    : path.includes("~");
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

/**
 * True when `path` is `root` or lies beneath it. A POSIX root matches exactly;
 * a drive root matches case-insensitively (NTFS) and a drive root such as
 * `C:/` contains the whole drive. Both arguments are already normalised.
 */
export function isPathRootOrChild(path: string, root: string) {
  if (isDriveAbsolutePath(root)) {
    const lowerPath = path.toLowerCase();
    const lowerRoot = root.toLowerCase();
    const prefix = lowerRoot.endsWith("/") ? lowerRoot : `${lowerRoot}/`;
    return lowerPath === lowerRoot || lowerPath.startsWith(prefix);
  }
  return path === root || path.startsWith(`${root}/`);
}

function isRootOrChild(path: string, root: string) {
  return isPathRootOrChild(path, normalizePath(root));
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

function formatRoots(roots: readonly string[], driveAware = false) {
  return roots.map((root) => normalizeSandboxPath(root, driveAware)).join(", ");
}

function policyRoots(input: {
  policy: SandboxProviderPathPolicy;
  kind: keyof Pick<
    SandboxProviderPathPolicy,
    "prepareTargetRoots" | "collectSourceRoots" | "readWriteRoots"
  >;
}) {
  const driveAware = policyUsesDrivePaths(input.policy);
  return input.policy[input.kind].map((root) =>
    normalizeSandboxPath(root, driveAware),
  );
}

function assertProviderSandboxPath(input: {
  value: string;
  roots: readonly string[];
  code: string;
  description: string;
  driveAware: boolean;
}) {
  const path = normalizeSandboxPath(input.value, input.driveAware);
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    hasHomeExpansion(path) ||
    !input.roots.some((root) => isPathRootOrChild(path, root))
  ) {
    throw new Error(
      `${input.code}: ${input.description} must be under ${formatRoots(input.roots, input.driveAware)}.`,
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
    "prepareTargetRoots" | "collectSourceRoots" | "readWriteRoots"
  >;
  code: string;
  description: string;
}) {
  const driveAware = policyUsesDrivePaths(input.policy);
  const path = normalizeSandboxPath(input.value, driveAware);
  assertNotSourceWeftVfsPath(path, input.code);
  return assertProviderSandboxPath({
    value: path,
    roots: policyRoots({ policy: input.policy, kind: input.kind }),
    code: input.code,
    description: input.description,
    driveAware,
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
  const driveAware = policyUsesDrivePaths(policy);
  const path = normalizeSandboxPath(value, driveAware);
  if (hasControlChars(path) || path.includes("..") || hasHomeExpansion(path)) {
    throw new Error(
      `SANDBOX_FILE_PATH_DENIED: path must be under ${formatRoots(policy.readWriteRoots, driveAware)}.`,
    );
  }
  assertNotSourceWeftVfsPath(path, "SANDBOX_FILE_PATH_DENIED");
  if (
    !policy.readWriteRoots
      .map((root) => normalizeSandboxPath(root, driveAware))
      .some((root) => isPathRootOrChild(path, root))
  ) {
    throw new Error(
      `SANDBOX_FILE_PATH_DENIED: ${path} is outside allowed sandbox roots. Use paths under ${formatRoots(policy.readWriteRoots, driveAware)}.`,
    );
  }
  return path;
}

export function assertExecuteCwd(
  value: string | undefined,
  policy: SandboxProviderPathPolicy,
) {
  const driveAware = policyUsesDrivePaths(policy);
  const path = normalizeSandboxPath(value || policy.defaultCwd, driveAware);
  const workspaceRoot = normalizeSandboxPath(policy.workspaceRoot, driveAware);
  assertNotSourceWeftVfsPath(path, "SANDBOX_EXECUTE_CWD_DENIED");
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    hasHomeExpansion(path) ||
    !isPathRootOrChild(path, workspaceRoot)
  ) {
    throw new Error(
      `SANDBOX_EXECUTE_CWD_DENIED: cwd must be under ${workspaceRoot}.`,
    );
  }
  return path;
}

export function assertSandboxReadPath(
  value: string,
  policy: SandboxProviderPathPolicy,
) {
  const driveAware = policyUsesDrivePaths(policy);
  const path = normalizeSandboxPath(value, driveAware);
  assertNotSourceWeftVfsPath(path, "SANDBOX_READ_PATH_DENIED");
  if (
    hasControlChars(path) ||
    path.includes("..") ||
    hasHomeExpansion(path) ||
    !policy.readWriteRoots
      .map((root) => normalizeSandboxPath(root, driveAware))
      .some((root) => isPathRootOrChild(path, root))
  ) {
    throw new Error(
      `SANDBOX_READ_PATH_DENIED: path must be under ${formatRoots(policy.readWriteRoots, driveAware)}.`,
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
 * resolved for the sandbox (two-phase check: /files and /kb fail fast,
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
  // `C:/a` → `C:/` and `C:/` → `C:/`: the parent of a drive child keeps its drive.
  if (isDriveAbsolutePath(path) && index === 2) return path.slice(0, 3);
  return index <= 0 ? "/" : path.slice(0, index);
}
