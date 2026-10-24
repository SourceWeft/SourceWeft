/**
 * Builds the srt `SandboxRuntimeConfig` from the sidecar's own policy inputs (`InitConfig`)
 * and the host's own interface addresses. `buildConfig` is the static, per-sidecar-lifetime
 * part of the policy (network, filesystem read access, helper paths); it never grants any
 * write access. `perCommandConfig` is the small, per-command overlay that grants write
 * access to exactly that command's workspace root — the caller (Task 3's server) merges the
 * two before handing the result to srt.
 */
import { isAbsolute, normalize as normalizePosix } from "node:path/posix";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { InitConfig } from "./protocol.js";

/**
 * Thrown by `buildConfig` when an `InitConfig` path field is not absolute. `code` is always
 * `'POLICY_INVALID'`, the matching `SidecarErrorCode` — Task 3's server catches this and
 * reports it on the wire verbatim, rather than letting a relative path reach srt.
 */
export class PolicyInvalidError extends Error {
  readonly code = "POLICY_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "PolicyInvalidError";
  }
}

/**
 * `home`/`workspaceRoots`/`readRoots` are passed straight into srt's filesystem policy as
 * `literal: true` paths — srt does not resolve them against a cwd, so a relative entry would
 * silently fail to deny/allow what the caller intended. Both platforms `InitConfig.platform`
 * allows (`linux`, `darwin`) are POSIX, so "absolute" is checked with POSIX semantics
 * regardless of the host OS this sidecar happens to run its tests on.
 */
function assertAbsolute(field: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new PolicyInvalidError(
      `${field} must be an absolute path, got ${JSON.stringify(path)}`,
    );
  }
}

// Resolved-address ranges srt itself re-checks after DNS resolution, as a second layer
// behind `address-guard.ts`'s pre-resolution checks on the literal host string. Loopback,
// link-local, multicast and the specific cloud-metadata addresses are not repeated here:
// srt's own defaults, together with this sidecar's `address-guard.ts`, already cover them.
/**
 * srt always makes its own `/tmp/claude` TMPDIR writable (`SANDBOX_OWN_WRITE_PATHS`) when it
 * exists on the host, which would be a write location shared by every command outside its
 * workspace (Ruling R15). `denyWrite` takes precedence over srt's own write paths; commands get
 * a workspace-local `TMPDIR` from the host instead.
 */
const DENIED_WRITE_PATHS: readonly string[] = ["/tmp/claude", "/private/tmp/claude"];

const DENIED_RESOLVED_ADDRESSES: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
];

/**
 * The read roots every wrapped command gets on top of its own workspace root: the init
 * `readRoots` plus the two helper *files* srt runs or loads inside the sandbox from their host
 * paths — `apply-seccomp` (executed by the wrapped shell) and the Java proxy agent jar (loaded by
 * a JVM). Those live in the host's sandbox bundle, under the app data directory, which `home`
 * and `denyRoots` deny; srt honours an exact file `allowRead` inside a denied directory, so only
 * these two files are carved out. `ripgrep` runs host-side and is not included.
 */
export function perWrapReadRoots(init: InitConfig): string[] {
  const helpers = [init.helpers.applySeccomp, init.helpers.javaAgentJar].filter(
    (path): path is string => path !== undefined,
  );
  return [...init.readRoots, ...helpers];
}

/**
 * The sidecar-lifetime srt config: network policy, read-only filesystem access (the whole
 * home directory denied, then the workspace roots and read roots re-allowed as literal
 * paths), and helper binary paths. Grants no filesystem write access — that is always added
 * per command by `perCommandConfig`. The host's own interface addresses (what `deniedReason`
 * calls `own`) play no part here — srt's own network config has no per-host notion of "own
 * addresses" to wire it into; Task 3's server applies them only in the ask callback, via
 * `deniedReason` directly.
 *
 * @throws {PolicyInvalidError} if `init.home`, or any entry of `init.workspaceRoots` or
 * `init.readRoots`, is not an absolute path.
 */
export function buildConfig(init: InitConfig): SandboxRuntimeConfig {
  assertAbsolute("home", init.home);
  init.workspaceRoots.forEach((path, i) =>
    assertAbsolute(`workspaceRoots[${i}]`, path),
  );
  init.readRoots.forEach((path, i) => assertAbsolute(`readRoots[${i}]`, path));
  if (init.helpers.applySeccomp !== undefined) {
    assertAbsolute("helpers.applySeccomp", init.helpers.applySeccomp);
  }
  if (init.helpers.javaAgentJar !== undefined) {
    assertAbsolute("helpers.javaAgentJar", init.helpers.javaAgentJar);
  }
  const denyRoots = init.denyRoots ?? [];
  denyRoots.forEach((path, i) => assertAbsolute(`denyRoots[${i}]`, path));

  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      deniedResolvedAddresses: [...DENIED_RESOLVED_ADDRESSES],
    },
    filesystem: {
      denyRead: [init.home, ...denyRoots].map((path) => ({ path, literal: true as const })),
      allowRead: [...init.workspaceRoots, ...perWrapReadRoots(init)].map((path) => ({
        path,
        literal: true as const,
      })),
      allowWrite: [],
      denyWrite: DENIED_WRITE_PATHS.map((path) => ({ path, literal: true as const })),
      allowGitConfig: true,
    },
    ripgrep: { command: init.helpers.ripgrep },
  };

  if (init.bwrapPath !== undefined) config.bwrapPath = init.bwrapPath;
  if (init.helpers.applySeccomp !== undefined) {
    config.seccomp = { applyPath: init.helpers.applySeccomp };
  }
  if (init.helpers.javaAgentJar !== undefined) {
    config.javaAgentJarPath = init.helpers.javaAgentJar;
  }

  return config;
}

/**
 * The per-command overlay: write access to exactly `workspaceRoot`, and read access (inside the
 * denied home) to exactly `workspaceRoot` plus the init `readRoots` (Ruling R14) — the other
 * init `workspaceRoots` are *not* re-allowed for this command. `buildConfig`'s `allowRead` (the
 * union) is only what `initialize` and `wrap` validation see; the merged config srt receives per
 * wrap replaces it with this overlay's `allowRead`, and concatenates this `allowWrite` onto
 * `buildConfig`'s own (always empty) one. `workspaceRoot` is expected to already have been
 * through `assertWorkspaceRootAllowed` (fix round 1 review: this function itself does not
 * validate it).
 */
export function perCommandConfig(
  workspaceRoot: string,
  readRoots: readonly string[],
): Partial<SandboxRuntimeConfig> {
  return {
    filesystem: {
      denyRead: [],
      allowRead: [workspaceRoot, ...readRoots].map((path) => ({ path, literal: true as const })),
      allowWrite: [{ path: workspaceRoot, literal: true }],
      denyWrite: [],
    },
  };
}

/**
 * Normalizes an already-absolute POSIX `path` — collapsing `.`/`..` segments and duplicate
 * separators purely lexically (never resolving against a cwd, unlike `node:path.resolve`) —
 * so a `..`-traversal attempt in a caller-supplied path is defanged before it is compared
 * against anything or handed to srt. Throws `PolicyInvalidError` first if `path` is not
 * absolute to begin with.
 */
function normalizedAbsolute(field: string, path: string): string {
  assertAbsolute(field, path);
  return normalizePosix(path);
}

/**
 * True when `child` is `parent` itself, or lexically nested inside it. Both arguments must
 * already be normalized absolute paths (see `normalizedAbsolute`) — this does only a string
 * comparison, with a `/` boundary so `/a/b` is not mistaken for being inside `/a/bc`.
 */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

/**
 * Validates a `wrap`/`probe` request's `workspaceRoot` — the one path a per-command overlay is
 * ever allowed to widen write access to — against `init.workspaceRoots`: it must be absolute
 * and equal to, or nested inside, one of them. Returns the normalized path, which is the only
 * form that should ever reach `perCommandConfig`/srt from here on (fix round 1 review: without
 * this check, a relative or out-of-tree `workspaceRoot` on the wire — including one built with
 * a `..` traversal — would reach srt's literal-path filesystem policy unchecked, since srt
 * never resolves a literal path against a cwd on its own).
 *
 * @throws {PolicyInvalidError} if `workspaceRoot` is not absolute, or is not one of
 * `initWorkspaceRoots` nor nested inside one of them.
 */
export function assertWorkspaceRootAllowed(
  workspaceRoot: string,
  initWorkspaceRoots: readonly string[],
): string {
  const normalized = normalizedAbsolute("workspaceRoot", workspaceRoot);
  const allowed = initWorkspaceRoots.some((root) =>
    isWithin(normalizePosix(root), normalized),
  );
  if (!allowed) {
    throw new PolicyInvalidError(
      `workspaceRoot ${JSON.stringify(workspaceRoot)} is not one of init's workspaceRoots, nor nested inside one`,
    );
  }
  return normalized;
}

/**
 * Validates a `wrap` request's `cwd` against its (already-`assertWorkspaceRootAllowed`-ed)
 * `workspaceRoot`: it must be absolute and equal to, or nested inside, that workspace root.
 * Returns the normalized path. See `assertWorkspaceRootAllowed`'s doc for why this matters —
 * srt resolves a relative `cwd` against the sidecar process's own `process.cwd()`, not the
 * command's intended working directory, so an unchecked `cwd` could point the wrapped command
 * somewhere entirely outside the write access it was actually granted.
 *
 * @throws {PolicyInvalidError} if `cwd` is not absolute, or is not `workspaceRoot` itself nor
 * nested inside it.
 */
export function assertCwdWithinWorkspace(cwd: string, workspaceRoot: string): string {
  const normalized = normalizedAbsolute("cwd", cwd);
  if (!isWithin(workspaceRoot, normalized)) {
    throw new PolicyInvalidError(
      `cwd ${JSON.stringify(cwd)} is not workspaceRoot ${JSON.stringify(workspaceRoot)}, nor nested inside it`,
    );
  }
  return normalized;
}
