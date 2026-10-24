/**
 * Builds the srt `SandboxRuntimeConfig` from the sidecar's own policy inputs (`InitConfig`)
 * and the host's own interface addresses. `buildConfig` is the static, per-sidecar-lifetime
 * part of the policy (network, filesystem read access, helper paths); it never grants any
 * write access. `perCommandConfig` is the small, per-command overlay that grants write
 * access to exactly that command's workspace root — the caller (Task 3's server) merges the
 * two before handing the result to srt.
 */
import { isAbsolute } from "node:path/posix";
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
const DENIED_RESOLVED_ADDRESSES: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
];

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

  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      deniedResolvedAddresses: [...DENIED_RESOLVED_ADDRESSES],
    },
    filesystem: {
      denyRead: [{ path: init.home, literal: true }],
      allowRead: [...init.workspaceRoots, ...init.readRoots].map((path) => ({
        path,
        literal: true as const,
      })),
      allowWrite: [],
      denyWrite: [],
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
 * The per-command overlay: write access to exactly `workspaceRoot`, nothing else. Merge this
 * on top of `buildConfig`'s result (e.g. by concatenating `filesystem.allowWrite`) for each
 * wrapped command — never widen `buildConfig`'s own `allowWrite`, which stays empty for the
 * sidecar's whole lifetime.
 */
export function perCommandConfig(
  workspaceRoot: string,
): Partial<SandboxRuntimeConfig> {
  return {
    filesystem: {
      denyRead: [],
      allowWrite: [{ path: workspaceRoot, literal: true }],
      denyWrite: [],
    },
  };
}
