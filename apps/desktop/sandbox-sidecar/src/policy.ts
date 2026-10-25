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
import { UNROUTABLE_V4, UNROUTABLE_V6 } from "./address-guard.js";
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
 * macOS system read roots re-allowed on top of the `"/"` deny (spec §4/§7.2), discovered
 * empirically by driving real commands through the sandbox on this macOS (26.x, APFS with the
 * `/etc`→`private/etc` and `/var`→`private/var` symlinks). Each entry names the real command that
 * failed without it. Narrow literal files and subpaths are preferred over broad directories;
 * `/Users`, `/Library` (as a whole), `/private/var/db`, `/private/var/folders` and `/Volumes`
 * stay denied. The developer directory (`xcode-select -p`), `/opt/homebrew`, `/usr/local` and the
 * PATH-derived toolchain roots are discovered host-side in `srt_exec.rs` and arrive as
 * `init.readRoots`, not here.
 *
 * A top-level directory reached through one of macOS's root symlinks needs BOTH spellings: the
 * symlink spelling (`/etc`, `/var`) so the kernel can traverse the link, and the resolved
 * spelling (`/private/etc`, `/private/var/...`) for the file contents behind it. srt only emits
 * a second (resolved) spelling for the final component of an allow, not for a leading symlink, so
 * the traversal spelling must be listed explicitly. Granting the `/var` symlink does NOT re-open
 * `/private/var` contents (verified: `/private/var/db`, `/private/var/folders`, `/var/root`,
 * `/var/log` stay denied in both spellings) — the kernel resolves `/var`→`/private/var` for every
 * real file op, and those resolved paths match no allow.
 */
const DARWIN_SYSTEM_READ_ROOTS: readonly string[] = [
  // `cat`, `ls`: the core system executables live here (`/bin/cat`, `/bin/ls`, `/bin/bash` — srt's
  // `binShell`). Without it, `cat marker.txt` fails with `/bin/bash: cat: command not found`.
  "/bin",
  // `grep`, `sed`, `awk`, `find`, `tar`, `gzip`, `curl`, `git`, `make`, `cc`/`clang`, `xcrun`: the
  // rest of the system toolchain. Without it, `sed -n 2p file` fails with `command not found`.
  "/usr/bin",
  // `curl https://…`: curl's default CA bundle is `/etc/ssl/cert.pem`, opened through the `/etc`
  // symlink; and `/etc/hosts` for name resolution. Without `/etc`, `curl` fails with
  // `error setting certificate verify locations: CAfile: /etc/ssl/cert.pem` (exit 77).
  "/etc",
  // The content `/etc` resolves to (`hosts`, `ssl/cert.pem`, `resolv.conf`, `passwd`/`group`).
  // With `/etc` but not `/private/etc`, `cat /etc/hosts` is `Operation not permitted` and curl's
  // CA read still fails. Its secrets (`master.passwd`, private keys) are root-only (mode 0600) and
  // unreadable to the sandboxed user anyway (verified: `cat /etc/master.passwd` → Permission
  // denied).
  "/private/etc",
  // `cc hello.c` (the `/usr/bin` xcode-select shim): xcrun resolves the active developer dir by
  // reading `/var/select/developer_dir`, reached through the `/var` symlink. Without `/var`, the
  // shim fails with `xcode-select: error: unable to read data link at '/var/select/developer_dir'`.
  "/var",
  // The directory `/var/select` resolves to, holding the `developer_dir` symlink xcrun reads. With
  // `/var` but not `/private/var/select`, the same `readlink` is `Operation not permitted`.
  "/private/var/select",
  // `head -c4 /dev/urandom`: device nodes (`/dev/null`, `/dev/urandom`, `/dev/random`, tty).
  // Without it the read is `Operation not permitted`. Sensitive nodes (`/dev/disk*`) are root-only
  // (mode `brw-r-----`) and stay unreadable to the sandboxed user.
  "/dev",
  // `node -e …`: Node's bundled OpenSSL opens `/System/Library/OpenSSL/openssl.cnf` at startup.
  // Without it Node aborts with `BIO_new_file … fopen(/System/Library/OpenSSL//openssl.cnf …
  // Operation not permitted)`. The rest of `/System` stays denied — frameworks load from the dyld
  // shared cache, which srt's base profile already allows.
  "/System/Library/OpenSSL",
];

/**
 * Ruling R25 (final review I2): credential files and directories under the home directory that a
 * toolchain read root (Ruling R13: `~/.cargo/bin` on `PATH` re-allows `~/.cargo`), or a granted
 * folder that is or contains `$HOME`, could otherwise expose. `.ssh`, `.aws` and `.gnupg` are
 * directories (private keys, cloud credentials, keyrings; Ruling R10 of the final review): a
 * literal `denyRead` of a directory denies everything below it. Each is a literal `denyRead`
 * entry, which srt keeps denied inside an `allowRead` directory. They are listed unconditionally rather than only when
 * their parent happens to be readable: an entry whose parent is denied or absent mounts nothing
 * (srt skips it), so the unconditional list is the same policy with no case to get wrong.
 */
const HOME_CREDENTIAL_PATHS: readonly string[] = [
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".docker/config.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".config/gh/hosts.yml",
  ".ssh",
  ".aws",
  ".gnupg",
];

/**
 * macOS-only credential directory that must stay unreadable even when a granted workspace, a
 * granted `$HOME`, or a granted `~/Library` would otherwise re-allow it. `~/Library/Keychains`
 * holds the login keychain (`login.keychain-db`), where Safari/Chrome passwords, app secrets and
 * certificate private keys live; upstream srt issue #755 is that a `denyRead:["/"]` sandbox can
 * still read it unless it is denied literally. Listed as a `home`-relative path so it applies to
 * whatever `init.home` the wrap runs under — including a fake `$HOME` that is itself the granted
 * workspace (the regression test `a granted fake home ... still hides it`). The system-wide
 * `/Library/Keychains` is covered by the unconditional `"/"` deny, since `/Library` is never a
 * re-allowed read root.
 */
const DARWIN_CREDENTIAL_DIRS: readonly string[] = ["Library/Keychains"];

/**
 * `HOME_CREDENTIAL_PATHS` (both platforms) plus, on darwin, `DARWIN_CREDENTIAL_DIRS`, as absolute
 * paths under `home`. srt keeps a literal `denyRead` entry denied even inside an `allowRead`
 * directory, so these survive a granted parent.
 */
function credentialDenies(platform: InitConfig["platform"], home: string): string[] {
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  const relatives =
    platform === "darwin"
      ? [...HOME_CREDENTIAL_PATHS, ...DARWIN_CREDENTIAL_DIRS]
      : HOME_CREDENTIAL_PATHS;
  return relatives.map((relative) => `${base}/${relative}`);
}

// Resolved-address ranges srt itself re-checks after DNS resolution, as a second layer
// behind `address-guard.ts`'s pre-resolution checks on the literal host string (srt never
// re-judges an IP literal, so `address-guard.ts` carries the full policy for literals).
// Loopback, unspecified (0.0.0.0/8, ::), link-local, multicast, broadcast, the cloud-metadata
// addresses and the host's own interface addresses are not repeated here: srt's built-in
// denied set already covers them (see "Resolved-address check" in srt's README). Private-use
// space is opt-in in srt, hence the first five entries; the documentation, reserved and
// non-global-unicast ranges come from `address-guard.ts` so both layers share one list.
//
// 198.18.0.0/15 (benchmarking) is deliberately NOT denied, although the retired macOS proxy
// denied it: it is no private network, and Clash/TUN fake-IP DNS answers public names with
// 198.18.x.x — denying it would break all egress for those users.
const DENIED_RESOLVED_ADDRESSES: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
  ...UNROUTABLE_V4,
  ...UNROUTABLE_V6,
];

/**
 * The read roots every wrapped command gets on top of its own workspace root: on Linux the
 * system read set (`LINUX_SYSTEM_READ_ROOTS`) and the sidecar's own `runtimeDir`, on darwin the
 * system read set (`DARWIN_SYSTEM_READ_ROOTS`; macOS has no sidecar `runtimeDir`), then the init
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
      : [...DARWIN_SYSTEM_READ_ROOTS];
  return [...system, ...init.readRoots, ...helpers];
}

/**
 * The sidecar-lifetime srt config: network policy, read-only filesystem access (on both Linux and
 * darwin the whole filesystem (`/`) and the home directory denied, the home credential files
 * denied — plus `~/Library/Keychains` on darwin — then the workspace roots and read roots
 * re-allowed as literal paths), and helper binary
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
        "/",
        init.home,
        ...denyRoots,
        ...credentialDenies(init.platform, init.home),
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
