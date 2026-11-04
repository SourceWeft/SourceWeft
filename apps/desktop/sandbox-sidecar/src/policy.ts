/**
 * Builds the srt `SandboxRuntimeConfig` from the sidecar's own policy inputs (`InitConfig`)
 * and the host's own interface addresses. `buildConfig` is the static, per-sidecar-lifetime
 * part of the policy (network, filesystem read access, helper paths); it never grants any
 * write access. `perCommandConfig` is the small, per-command overlay that grants write
 * access to exactly that command's workspace root — the caller (Task 3's server) merges the
 * two before handing the result to srt.
 *
 * `win32` is a different model from the two POSIX platforms (see `buildWin32Config`): srt
 * bounds reads there with NTFS ACLs rather than a deny-by-default policy, and cannot take a
 * per-command grant. Every Windows path operation here uses `node:path/win32` explicitly, so
 * the policy (and its tests) behave the same on whatever OS the sidecar happens to run on.
 */
import { lstatSync } from "node:fs";
import { isAbsolute, normalize as normalizePosix } from "node:path/posix";
import * as win32 from "node:path/win32";
import type { FilterRequestCallback, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { UNROUTABLE_V4, UNROUTABLE_V6 } from "./address-guard.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { InitConfig } from "./protocol.js";
// One list for both sides: the desktop host (`winpath.rs`) refuses a folder inside any of these
// before it is ever granted, and the policy below refuses it again at `init`.
import windowsProtectedPaths from "./windows-protected-paths.json" with { type: "json" };

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
 * silently fail to deny/allow what the caller intended. "Absolute" is checked with the
 * semantics of the platform the path is for, regardless of the host OS this sidecar happens
 * to run its tests on: POSIX for `linux`/`darwin`, and for `win32` a drive path only
 * (`C:\x` or `C:/x`). Root-relative (`\x`), drive-relative (`C:x`), UNC (`\\srv\share`)
 * and device/verbatim (`\\?\`, `\\.\`) spellings are refused: srt grants and stamps ACLs on
 * what a path names, and those forms name network shares or bypass normalization.
 */
function assertAbsolute(platform: InitConfig["platform"], field: string, path: string): void {
  const ok = platform === "win32" ? WIN32_DRIVE_PATH.test(path) : isAbsolute(path);
  if (!ok) {
    throw new PolicyInvalidError(
      `${field} must be an absolute ${platform === "win32" ? "drive " : ""}path, got ${JSON.stringify(path)}`,
    );
  }
}

const WIN32_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

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
 * `/Users`, `/Library` (as a whole), `/private/var/folders` and `/Volumes` stay denied, and so does
 * `/private/var/db` save for the single world-readable `timezone` subpath `date` needs (the
 * password-hash store `/private/var/db/dslocal` and everything else under it stay denied — verified).
 * The developer directory (`xcode-select -p`), `/opt/homebrew`, `/usr/local` and the
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
  // `echo hi | shasum -a 256` (and `shasum -a 512`, any `perl -e …`): `shasum` is a Perl script and
  // `/usr/bin/perl` loads its interpreter dylib and XS modules from here — without it the process
  // aborts with `dyld: Library not loaded: /System/Library/Perl/5.34/…/CORE/libperl.dylib (blocked
  // by sandbox)` (SIGABRT), and skill-staging `shasum -a 256 -c` verification fails. Perl's core
  // modules (`Digest::SHA` for `shasum`) live under the same tree. The read is scoped to this
  // subpath only: a sibling such as `/System/Library/Keychains` stays denied (verified).
  "/System/Library/Perl",
  // `md5 file` / `md5 -q`: BSD `md5`, `md5sum`, and the rest of the single-binary system tools live
  // in `/sbin` (`/sbin/md5`), which is on the login PATH but was otherwise unreadable, so a bare
  // `md5` was `command not found`. `/sbin` holds only system executables (no secrets).
  "/sbin",
  // `tput colors` (terminfo under `/usr/share/terminfo`), `file magic.bin` (magic database under
  // `/usr/share/file`), `iconv` (charset data), the `/usr/share/zoneinfo` symlink, man pages and
  // git templates: all read world-readable OS data shipped under `/usr/share`. Without it `tput` is
  // `unknown terminal`, `file` reports `could not find any valid magic files`, and `iconv_open`
  // fails with `Invalid argument`. `/usr/share` carries only system data — user secrets live under
  // `$HOME`, `/Library` and `/Users`, all still denied.
  "/usr/share",
  // The zoneinfo database `date` reads for a non-UTC `TZ` (`TZ=America/New_York date +%Z` → `EDT`):
  // `/usr/share/zoneinfo` (covered by `/usr/share`) is a symlink into `/var/db/timezone/…`, so the
  // actual data needs this one narrow subpath of the otherwise-denied `/private/var/db`. It holds
  // only world-readable timezone tables; the rest of `/private/var/db` — notably the `dslocal`
  // password-hash store — stays denied (verified: `ls /private/var/db/dslocal` → Operation not
  // permitted with this entry present).
  "/private/var/db/timezone",
  // `sw_vers`: reads the OS version from this one file and fails with `Unknown error loading system
  // version plist` without it. Allowed as a single literal file (not the directory), so siblings
  // under `/System/Library/CoreServices` stay denied (verified: `ls …/Finder.app` → Operation not
  // permitted). `date` needs no entry of its own beyond the zoneinfo paths above.
  "/System/Library/CoreServices/SystemVersion.plist",
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

/** True when `path` exists (a symlink counts, dangling or not). */
function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The credential paths (`credentialDenies`) that must also stay unwritable, so a granted `$HOME`
 * workspace cannot overwrite a private key or plant `~/.ssh/authorized_keys`. `denyWrite` takes
 * precedence over srt's `allowWrite` for the workspace.
 *
 * darwin: all of them, unconditionally (`buildConfig`) — Seatbelt matches a path rule whether or
 * not the path exists and creates nothing on the host.
 *
 * linux: only the ones that exist right now AND lie inside (or equal) `workspaceRoot`
 * (`perWrapWriteDenies`, per command). The workspace root is the only writable root, so a write
 * deny elsewhere protects nothing; worse, a credential path inside a read-only toolchain root
 * (`~/.cargo/credentials.toml` under the `~/.cargo` read root) makes bubblewrap try to bind or
 * create a mount point in a read-only filesystem and the command fails to start. For an absent
 * deny path under a writable root, bubblewrap first creates an empty placeholder on the host
 * (the first missing component — for `~/.aws` an empty FILE, for `~/.config/gh/hosts.yml` a
 * `~/.config` directory) and removes it after the command. In a granted `$HOME` that would
 * transiently litter the real home, and leave a stray file there if the sidecar died mid-command.
 * Skipping absent paths is the safe subset: it leaves "the command creates a missing
 * `~/.ssh` itself" unprotected on Linux (reads of those paths stay denied everywhere).
 *
 * win32: none here; `perWrapDenies` returns the paths to deny for both read and write.
 */
export function perWrapWriteDenies(
  init: Pick<InitConfig, "platform" | "home">,
  workspaceRoot: string,
  exists: (path: string) => boolean = existsNoFollow,
): string[] {
  // win32 has its own combined read+write list (`perWrapDenies`).
  if (init.platform === "darwin" || init.platform === "win32") return [];
  const root = normalizePosix(workspaceRoot);
  return credentialDenies(init.platform, init.home).filter(
    (path) => isWithin(init.platform, root, normalizePosix(path)) && exists(path),
  );
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

/** The network policy, identical on every platform: nothing allowed up front, private space denied. */
function networkConfig(): SandboxRuntimeConfig["network"] {
  return {
    allowedDomains: [],
    deniedDomains: [],
    deniedResolvedAddresses: [...DENIED_RESOLVED_ADDRESSES],
  };
}

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
  // win32: the read roots are the whole story. There is no system set to re-allow (the sandbox
  // account already reads what `Users` reads), no runtime directory, and the helpers run
  // host-side or from the world-readable `srt-win.exe` install, not from the bundle.
  if (init.platform === "win32") return [...init.readRoots];
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
 * `win32` is a different model and is built by `buildWin32Config`.
 *
 * @throws {PolicyInvalidError} if `init.home`, `runtimeDir`, or any entry of
 * `init.workspaceRoots` or `init.readRoots`, is not an absolute path, or if `init.windows` is
 * given for a non-Windows platform.
 */
export function buildConfig(init: InitConfig, runtimeDir?: string): SandboxRuntimeConfig {
  if (init.platform === "win32") return buildWin32Config(init);
  if (init.windows !== undefined) {
    throw new PolicyInvalidError(`windows is only valid on win32, not ${init.platform}`);
  }
  const { platform } = init;
  assertAbsolute(platform, "home", init.home);
  if (runtimeDir !== undefined) assertAbsolute(platform, "runtimeDir", runtimeDir);
  init.workspaceRoots.forEach((path, i) =>
    assertAbsolute(platform, `workspaceRoots[${i}]`, path),
  );
  init.readRoots.forEach((path, i) => assertAbsolute(platform, `readRoots[${i}]`, path));
  if (init.helpers.applySeccomp !== undefined) {
    assertAbsolute(platform, "helpers.applySeccomp", init.helpers.applySeccomp);
  }
  if (init.helpers.javaAgentJar !== undefined) {
    assertAbsolute(platform, "helpers.javaAgentJar", init.helpers.javaAgentJar);
  }
  const denyRoots = init.denyRoots ?? [];
  denyRoots.forEach((path, i) => assertAbsolute(platform, `denyRoots[${i}]`, path));

  const config: SandboxRuntimeConfig = {
    network: networkConfig(),
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
      denyWrite: [
        ...deniedWritePaths(init.platform),
        ...(init.platform === "darwin" ? credentialDenies(init.platform, init.home) : []),
      ].map((path) => ({
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
 * Normalizes an already-absolute `path` for `platform` — collapsing `.`/`..` segments and
 * duplicate separators purely lexically (never resolving against a cwd, unlike
 * `node:path.resolve`) — so a `..`-traversal attempt in a caller-supplied path is defanged
 * before it is compared against anything or handed to srt. On `win32` the result also uses
 * backslashes only. Throws `PolicyInvalidError` first if `path` is not absolute to begin with.
 */
function normalizedAbsolute(platform: InitConfig["platform"], field: string, path: string): string {
  assertAbsolute(platform, field, path);
  return platform === "win32" ? win32.normalize(path) : normalizePosix(path);
}

/**
 * True when `child` is `parent` itself, or lexically nested inside it. Both arguments must
 * already be normalized absolute paths (see `normalizedAbsolute`) — this does only a string
 * comparison, with a `/` boundary so `/a/b` is not mistaken for being inside `/a/bc`. On
 * `win32` it is `isWithinWin32`: case-insensitive, with a `\` boundary.
 */
function isWithin(platform: InitConfig["platform"], parent: string, child: string): boolean {
  if (platform === "win32") return isWithinWin32(parent, child);
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
  platform: InitConfig["platform"],
): string {
  const normalized = normalizedAbsolute(platform, "workspaceRoot", workspaceRoot);
  const allowed = initWorkspaceRoots.some((root) =>
    isWithin(
      platform,
      platform === "win32" ? win32.normalize(root) : normalizePosix(root),
      normalized,
    ),
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
export function assertCwdWithinWorkspace(
  cwd: string,
  workspaceRoot: string,
  platform: InitConfig["platform"],
): string {
  const normalized = normalizedAbsolute(platform, "cwd", cwd);
  if (!isWithin(platform, workspaceRoot, normalized)) {
    throw new PolicyInvalidError(
      `cwd ${JSON.stringify(cwd)} is not workspaceRoot ${JSON.stringify(workspaceRoot)}, nor nested inside it`,
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

/**
 * The machine-wide names the namespaced `srt-win` of the SourceWeft fork was built with
 * (`.sourceweft/README.md` in the fork: namespace `sourceweft`, account `sourceweft-sandbox`,
 * proxy ports `60180-60189`, and a compile-time WFP sublayer GUID). They are fixed at build
 * time in the binary, so they are fixed here too and never taken from the host: a different
 * value could only ever make srt look at the wrong (or upstream's) install.
 */
const WINDOWS_SANDBOX_USER = "sourceweft-sandbox";
const WINDOWS_PROXY_PORT_RANGE: [number, number] = [60180, 60189];

/**
 * Credential stores under the user's profile that must stay unreadable and unwritable even when
 * a granted workspace or a toolchain read root contains them (a granted profile, or a `PATH`
 * entry such as `~\.cargo\bin` that reads like a directory of its own), and that no workspace or
 * read root may lie inside (`assertRootsOutsideProtected`). Relative to `home`,
 * backslash-separated; `windows-protected-paths.json` is the single list (the desktop host reads
 * the same file). Dotfile credentials and CLI token directories first, then the Roaming and
 * Local `AppData` stores: the Credential Manager and DPAPI master keys (`Microsoft\Credentials`,
 * `Protect`, `Vault`, `Crypto`), certificate stores, password-manager vaults and browser profiles
 * (cookies and saved logins), editor extension storage and the global npm configuration.
 */
const WIN32_CREDENTIAL_PATHS: readonly string[] = windowsProtectedPaths.relativeToHome;

/** `path` normalized to backslashes, minus a trailing separator (a drive root keeps its one), lowercased. */
function windowsKey(path: string): string {
  const normalized = win32.normalize(path);
  const trimmed = normalized.length > 3 && normalized.endsWith("\\") ? normalized.slice(0, -1) : normalized;
  return trimmed.toLowerCase();
}

/**
 * `isWithin` for Windows: NTFS paths compare case-insensitively and `/` equals `\\`, so both
 * sides go through `windowsKey` first. A separator boundary keeps `C:\a\bc` out of `C:\a\b`.
 */
function isWithinWin32(parent: string, child: string): boolean {
  const p = windowsKey(parent);
  const c = windowsKey(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith("\\") ? p : `${p}\\`);
}

/**
 * Every path whose contents must be hidden from a command that can otherwise reach it: the
 * host's own extra denies (`init.denyRoots`), then `WIN32_CREDENTIAL_PATHS` under `init.home`.
 * This is the candidate list only; `perWrapDenies` narrows it per command. Unlike POSIX it is
 * never handed to srt wholesale: an ACL deny on a path that does not exist makes `srt-win`
 * create a placeholder, and a deny outside every granted root protects nothing.
 */
export function protectedPaths(
  init: Pick<InitConfig, "home" | "denyRoots">,
): string[] {
  return [
    ...(init.denyRoots ?? []).map((path) => win32.normalize(path)),
    ...WIN32_CREDENTIAL_PATHS.map((relative) => win32.join(init.home, relative)),
  ];
}

/**
 * Refuses (POLICY_INVALID) any workspace root or read root that equals or lies INSIDE a protected
 * credential store under `home`. (The host's own `denyRoots` are not part of this: the readiness
 * probe's scratch workspace legitimately lives below one of them.) The per-command
 * deny list only covers protected paths that lie inside a root, so a root placed inside one
 * (`~\.ssh\proj` as a workspace, `~\AppData\Roaming\Mozilla\Firefox\Profiles\x` as a read
 * root) would be granted without any deny. A root that CONTAINS a protected path is fine: that
 * path is denied per command.
 */
function assertRootsOutsideProtected(init: InitConfig): void {
  const protectedList = protectedPaths({ home: init.home });
  const roots: Array<[string, string]> = [
    ...init.workspaceRoots.map((path, i): [string, string] => [`workspaceRoots[${i}]`, path]),
    ...init.readRoots.map((path, i): [string, string] => [`readRoots[${i}]`, path]),
  ];
  for (const [field, root] of roots) {
    const hit = protectedList.find((protectedPath) => isWithinWin32(protectedPath, root));
    if (hit !== undefined) {
      throw new PolicyInvalidError(
        `${field} ${JSON.stringify(root)} is inside the protected location ${JSON.stringify(hit)}`,
      );
    }
  }
}

/**
 * The protected paths to deny for one `win32` command, for read and for write: those that
 * exist right now (`lstat`, so a symlink or junction counts) and equal or lie inside
 * `workspaceRoot` or any init read root, compared case-insensitively. The workspace is the
 * only writable root and the read roots are the only other readable ones (the sandbox account
 * has no profile grant), so a deny anywhere else protects nothing, and an absent path would
 * be created as a placeholder by `srt-win`. Checked per command: a path that appears later is
 * covered by the next wrap. Both lists passed to srt are this same one, because a read deny
 * alone would leave the credential file overwritable inside a writable workspace.
 */
export function perWrapDenies(
  init: Pick<InitConfig, "home" | "denyRoots" | "readRoots">,
  workspaceRoot: string,
  exists: (path: string) => boolean = existsNoFollow,
): string[] {
  const roots = [workspaceRoot, ...init.readRoots];
  return protectedPaths(init).filter(
    (path) => roots.some((root) => isWithinWin32(root, path)) && exists(path),
  );
}

/**
 * The sidecar-lifetime srt config on `win32`. Differences from the POSIX platforms, all forced
 * by how srt-win works:
 * - **No blanket read deny.** The sandbox runs as a separate local account; reads are bounded by
 *   NTFS ACLs (it sees what `Users` sees, plus explicit grants). Denying `C:\` or the profile
 *   would stamp inheriting ACEs across a volume, so `denyRead`/`denyWrite` are empty here and
 *   the credential paths are denied per command instead (`perWrapDenies`).
 * - **Write access is per session.** `allowWrite` is the one workspace root, granted at
 *   `initialize`; srt refuses a per-command `allowWrite`. Hence exactly one workspace root per
 *   sidecar.
 * - `allowRead` is the read roots (the toolchain directories inside the profile), literal.
 * - The `windows` block names the namespaced install and the `srt-win.exe` the host staged.
 */
function buildWin32Config(init: InitConfig): SandboxRuntimeConfig {
  const { windows } = init;
  if (windows === undefined) {
    throw new PolicyInvalidError("windows (srtWin and shell) is required on win32");
  }
  assertAbsolute("win32", "home", init.home);
  if (init.workspaceRoots.length !== 1) {
    throw new PolicyInvalidError(
      `win32 needs exactly one workspace root per sidecar, got ${String(init.workspaceRoots.length)}`,
    );
  }
  init.workspaceRoots.forEach((path, i) => assertAbsolute("win32", `workspaceRoots[${i}]`, path));
  init.readRoots.forEach((path, i) => assertAbsolute("win32", `readRoots[${i}]`, path));
  (init.denyRoots ?? []).forEach((path, i) => assertAbsolute("win32", `denyRoots[${i}]`, path));
  assertAbsolute("win32", "windows.srtWin", windows.srtWin);
  assertAbsolute("win32", "windows.shell", windows.shell);
  assertRootsOutsideProtected(init);

  const [workspaceRoot] = init.workspaceRoots as [string];
  return {
    network: networkConfig(),
    filesystem: {
      denyRead: [],
      allowRead: init.readRoots.map((path) => ({ path, literal: true as const })),
      allowWrite: [{ path: workspaceRoot, literal: true as const }],
      denyWrite: [],
      allowGitConfig: true,
    },
    ripgrep: { command: init.helpers.ripgrep },
    windows: {
      srtWin: { path: windows.srtWin },
      sandboxUser: WINDOWS_SANDBOX_USER,
      proxyPortRange: [...WINDOWS_PROXY_PORT_RANGE],
    },
  };
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
