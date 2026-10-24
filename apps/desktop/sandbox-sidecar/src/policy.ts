/**
 * Builds the srt `SandboxRuntimeConfig` from the sidecar's own policy inputs (`InitConfig`)
 * and the host's own interface addresses. `buildConfig` is the static, per-sidecar-lifetime
 * part of the policy (network, filesystem read access, helper paths); it never grants any
 * write access. `perCommandConfig` is the small, per-command overlay that grants write
 * access to exactly that command's workspace root — the caller (Task 3's server) merges the
 * two before handing the result to srt.
 */
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { InitConfig } from "./protocol.js";

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
 * per command by `perCommandConfig`. `own` (the host's own interface addresses) is accepted
 * for symmetry with `deniedReason` and future use; srt's own network config has no per-host
 * notion of "own addresses" to wire it into here.
 */
export function buildConfig(
  init: InitConfig,
  own: ReadonlySet<string>,
): SandboxRuntimeConfig {
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
