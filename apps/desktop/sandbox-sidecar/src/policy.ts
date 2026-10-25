/**
 * Builds the srt `SandboxRuntimeConfig` from the sidecar's own policy inputs (`InitConfig`)
 * and the host's own interface addresses. `buildConfig` is the static, per-sidecar-lifetime
 * part of the policy (network, filesystem read access, helper paths); it never grants any
 * write access. `perCommandConfig` is the small, per-command overlay that grants write
 * access to exactly that command's workspace root — the caller (Task 3's server) merges the
 * two before handing the result to srt.
 */
import { isAbsolute, normalize as normalizePosix } from "node:path/posix";
import type { FilterRequestCallback, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { NetworkPolicy } from "./network-policy.js";
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

/**
 * srt always makes its own `/tmp/claude` TMPDIR writable (`SANDBOX_OWN_WRITE_PATHS`) when it
 * exists on the host, which would be a write location shared by every command outside its
 * workspace (Ruling R15). `denyWrite` takes precedence over srt's own write paths; commands get
 * a workspace-local `TMPDIR` from the host instead. `/private/tmp/claude` is the same directory
 * spelled through macOS's `/tmp` symlink; it means nothing on Linux, so only darwin lists it
 * (final review M1).
 */
function deniedWritePaths(platform: InitConfig["platform"]): string[] {
  return platform === "darwin" ? ["/tmp/claude", "/private/tmp/claude"] : ["/tmp/claude"];
}

/**
 * Ruling R24 (final review I1): on Linux the whole filesystem is read-denied (`/`, which srt
 * expands into a deny for each top-level directory not covered by an `allowRead` entry, always
 * leaving the `/proc`, `/dev` and `/sys` it mounts itself), and only this system set, the
 * command's own workspace root, the toolchain read roots and the two in-sandbox helper files
 * are re-allowed. Everything else stays unreadable: `/tmp` and `/var/tmp` (other programs'
 * temporary files; a command's `TMPDIR` lives in its workspace), `/run` (including
 * `/run/user/<uid>` with its gvfs mounts and portal), `/home` and `/root` (other users, and the
 * home directory itself, also denied by `home`), `/media`, `/mnt`, `/srv`, `/var`, `/boot`,
 * `/snap`, and every granted folder outside the home directory that is not this command's own.
 *
 * - `/usr`: programs, shared libraries, interpreters and their standard libraries, CA bundles
 *   (`/usr/share/ca-certificates`), zoneinfo; `/usr/local` toolchains.
 * - `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/libx32`: on a merged-`/usr` system these are
 *   symlinks into `/usr` (srt then skips denying them: their target is covered); on an older
 *   layout they are the real directories holding the shell, `ld.so` and libc. Absent entries
 *   are skipped by srt.
 * - `/etc`: the dynamic loader cache (`ld.so.cache`), `passwd`/`group`/`nsswitch.conf` (user
 *   and group lookups), `hosts` (resolving `localhost`, the name in the sandbox's proxy URLs),
 *   `ssl/certs`, `alternatives`, and tool configuration. World-readable system configuration;
 *   its secrets (`shadow`, private keys) are root-only and unreadable to the user anyway.
 * - `/opt`: system-wide third-party software (vendor JDKs, Node or Go tarball installs),
 *   root-managed and non-secret; includes `/opt/sourceweft/libexec/bwrap`, a public binary.
 */
const LINUX_SYSTEM_READ_ROOTS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
];

/**
 * Ruling R25 (final review I2): credential files under the home directory that a toolchain read
 * root (Ruling R13: `~/.cargo/bin` on `PATH` re-allows `~/.cargo`), or a granted folder that
 * contains them, could otherwise expose. Each is a literal `denyRead` entry, which srt keeps
 * denied inside an `allowRead` directory. They are listed unconditionally rather than only when
 * their parent happens to be readable: an entry whose parent is denied or absent mounts nothing
 * (srt skips it), so the unconditional list is the same policy with no case to get wrong.
 */
const HOME_CREDENTIAL_FILES: readonly string[] = [
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".docker/config.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".config/gh/hosts.yml",
];

/** `HOME_CREDENTIAL_FILES` as absolute paths under `home`. */
function credentialDenies(home: string): string[] {
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  return HOME_CREDENTIAL_FILES.map((relative) => `${base}/${relative}`);
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
 * The read roots every wrapped command gets on top of its own workspace root: on Linux the
 * system read set (`LINUX_SYSTEM_READ_ROOTS`) and the sidecar's own `runtimeDir`, then the init
 * `readRoots`, then the two helper
 * *files* srt runs or loads inside the sandbox from their host paths — `apply-seccomp`
 * (executed by the wrapped shell) and the Java proxy agent jar (loaded by a JVM). Those live in
 * the host's sandbox bundle, under the app data directory, which `home` and `denyRoots` deny;
 * srt honours an exact file `allowRead` inside a denied directory, so only these two files are
 * carved out. `ripgrep` runs host-side and is not included.
 */
export function perWrapReadRoots(init: InitConfig, runtimeDir?: string): string[] {
  const helpers = [init.helpers.applySeccomp, init.helpers.javaAgentJar].filter(
    (path): path is string => path !== undefined,
  );
  const system =
    init.platform === "linux"
      ? [...LINUX_SYSTEM_READ_ROOTS, ...(runtimeDir === undefined ? [] : [runtimeDir])]
      : [];
  return [...system, ...init.readRoots, ...helpers];
}

/**
 * The sidecar-lifetime srt config: network policy, read-only filesystem access (on Linux the
 * whole filesystem and on darwin the home directory denied, the home credential files denied,
 * then the workspace roots and read roots re-allowed as literal paths), and helper binary
 * paths. Grants no filesystem write access — that is always added
 * per command by `perCommandConfig`. The host's own interface addresses (what `deniedReason`
 * calls `own`) play no part here — srt's own network config has no per-host notion of "own
 * addresses" to wire it into; Task 3's server applies them only in the ask callback, via
 * `deniedReason` directly.
 *
 * `runtimeDir` is the private directory the sidecar points srt's `os.tmpdir()` at (see
 * `main.ts`). srt creates the Unix sockets its in-sandbox bridge connects to there, and binds
 * them into the sandbox *before* its filesystem mounts, so the Linux `/` read deny would hide
 * them again; re-allowing exactly this directory keeps them reachable without re-allowing `/tmp`.
 * It holds only srt's sockets and empty mount-source directories for this one sidecar.
 *
 * @throws {PolicyInvalidError} if `init.home`, `runtimeDir`, or any entry of
 * `init.workspaceRoots` or `init.readRoots`, is not an absolute path.
 */
export function buildConfig(init: InitConfig, runtimeDir?: string): SandboxRuntimeConfig {
  assertAbsolute("home", init.home);
  if (runtimeDir !== undefined) assertAbsolute("runtimeDir", runtimeDir);
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
      denyRead: [
        ...(init.platform === "linux" ? ["/"] : []),
        init.home,
        ...denyRoots,
        ...credentialDenies(init.home),
      ].map((path) => ({ path, literal: true as const })),
      allowRead: [...init.workspaceRoots, ...perWrapReadRoots(init, runtimeDir)].map((path) => ({
        path,
        literal: true as const,
      })),
      allowWrite: [],
      denyWrite: deniedWritePaths(init.platform).map((path) => ({
        path,
        literal: true as const,
      })),
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

/**
 * The srt `network.filterRequest` hook that audits plain-HTTP traffic. It is not a policy point:
 * it always allows, because every connection was already judged by the ask callback
 * (`NetworkPolicy.decide`) before srt's proxy got as far as parsing an HTTP request. Its only job
 * is to record method, host, port, path (no query) and the response status through
 * `NetworkPolicy.beginHttp`, which attributes the request to the single active command; a request
 * it cannot attribute is allowed and recorded nowhere.
 *
 * srt only calls a `filterRequest` for plain HTTP, and for HTTPS only when it terminates TLS, which
 * this sidecar does not do yet — so HTTPS appears in the audit as connections, never as requests.
 *
 * A throw here would deny the request (srt fails closed on a throwing callback), and an audit
 * must never change what a command can do, so everything that can fail is contained.
 *
 * Setting any `filterRequest` makes srt judge the request-target of plain HTTP: its default
 * `ambiguousRequestTarget` is `refuse`, so a target with dot segments or a backslash is refused
 * with a 400 where srt without a filter would have normalised and forwarded it.
 */
export function auditFilterRequest(begin: NetworkPolicy["beginHttp"]): FilterRequestCallback {
  return async (request, info) => {
    try {
      const url = new URL(request.url);
      const secure = info?.scheme === undefined ? url.protocol === "https:" : info.scheme === "https";
      const host = info?.target?.host ?? url.hostname;
      const port =
        info?.target?.port ?? (url.port === "" ? (secure ? 443 : 80) : Number(url.port));
      const path = info?.requestTarget ?? url.pathname;
      const done = begin({ host, port, method: request.method, path });
      if (done === null) return { action: "allow" };
      return {
        action: "allow",
        onResponse: (status) => {
          try {
            done(status);
          } catch {
            // Recording is best effort; srt would only log a failing callback anyway.
          }
        },
      };
    } catch {
      return { action: "allow" };
    }
  };
}
