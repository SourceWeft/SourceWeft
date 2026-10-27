import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConfig,
  perCommandConfig,
  perWrapReadRoots,
  perWrapWriteDenies,
  PolicyInvalidError,
} from "../src/policy.js";

const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt"];
// The darwin system read set re-allowed on top of the "/" deny (DARWIN_SYSTEM_READ_ROOTS).
const DARWIN_SYSTEM = [
  "/bin",
  "/usr/bin",
  "/etc",
  "/private/etc",
  "/var",
  "/private/var/select",
  "/dev",
  "/System/Library/OpenSSL",
  // perl/shasum interpreter + XS modules; /sbin (md5); /usr/share (terminfo, file magic, iconv,
  // zoneinfo symlink); the narrow zoneinfo data under the otherwise-denied /private/var/db; and
  // sw_vers's version plist as a single literal file.
  "/System/Library/Perl",
  "/sbin",
  "/usr/share",
  "/private/var/db/timezone",
  "/System/Library/CoreServices/SystemVersion.plist",
];
const CREDENTIAL_FILES = [
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
const CREDENTIALS = CREDENTIAL_FILES.map((relative) => ({
  path: `/home/u/${relative}`,
  literal: true,
}));
// On darwin the credential set also carries ~/Library/Keychains (upstream srt #755).
const DARWIN_CREDENTIALS = [...CREDENTIAL_FILES, "Library/Keychains"].map((relative) => ({
  path: `/home/u/${relative}`,
  literal: true,
}));
const literals = (paths: readonly string[]) => paths.map((path) => ({ path, literal: true }));
/** The paths of a filesystem entry list (srt also accepts bare strings there). */
const pathsOf = (entries: ReadonlyArray<string | { path: string }> | undefined): string[] =>
  (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));

function validInit(overrides: Partial<Parameters<typeof buildConfig>[0]> = {}) {
  return {
    platform: "linux" as const,
    home: "/home/u",
    workspaceRoots: ["/home/u/ws"],
    readRoots: ["/home/u/.nvm/versions/node/v22.1.0"],
    helpers: { ripgrep: "/opt/sw/rg" },
    ...overrides,
  };
}

test("linux denies / and home, re-allows the system set, workspace and read roots as literals", () => {
  const c = buildConfig({
    platform: "linux",
    home: "/home/u",
    workspaceRoots: ["/home/u/ws [1]"],
    readRoots: ["/home/u/.nvm/versions/node/v22.1.0"],
    helpers: { ripgrep: "/opt/sw/rg", applySeccomp: "/opt/sw/apply-seccomp" },
    bwrapPath: "/opt/sourceweft/libexec/bwrap",
  });
  // Ruling R24: the whole filesystem, then home, then (R25) the home credential files.
  assert.deepEqual(c.filesystem.denyRead, [
    { path: "/", literal: true },
    { path: "/home/u", literal: true },
    ...CREDENTIALS,
  ]);
  assert.deepEqual(c.filesystem.allowRead, [
    { path: "/home/u/ws [1]", literal: true },
    ...literals(SYSTEM),
    { path: "/home/u/.nvm/versions/node/v22.1.0", literal: true },
    { path: "/opt/sw/apply-seccomp", literal: true },
  ]);
  assert.deepEqual(c.filesystem.allowWrite, []);
  // Ruling R15: srt's own always-writable TMPDIR is denied; M1: only its Linux spelling.
  assert.deepEqual(c.filesystem.denyWrite, [{ path: "/tmp/claude", literal: true }]);
  assert.equal(c.filesystem.allowGitConfig, true);
  assert.deepEqual(c.network.allowedDomains, []);
  assert.deepEqual(c.network.deniedResolvedAddresses, [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "fc00::/7",
    // Documentation / reserved / non-global-unicast (see address-guard.ts UNROUTABLE_*). Not
    // 198.18.0.0/15: Clash/TUN fake-IP DNS answers public names from it.
    "192.0.2.0/24",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "240.0.0.0/4",
    "2001:db8::/32",
    "64:ff9b:1::/48",
    "100::/8",
    "200::/7",
    "400::/6",
    "800::/5",
    "1000::/4",
    "4000::/2",
    "8000::/1",
  ]);
  assert.equal(c.bwrapPath, "/opt/sourceweft/libexec/bwrap");
  assert.equal(c.seccomp?.applyPath, "/opt/sw/apply-seccomp");
  for (const k of [
    "allowLocalBinding",
    "allowUnixSockets",
    "allowAllUnixSockets",
    "enableWeakerNestedSandbox",
    "allowAppleEvents",
  ])
    assert.ok(!(k in c) && !(k in c.network), `${k} must not be set`);
});
test("darwin denies / and home (incl. ~/Library/Keychains), re-allows the darwin system set", () => {
  const c = buildConfig(validInit({ platform: "darwin", home: "/home/u" }));
  // "/" and home denied, then the credential files, then ~/Library/Keychains (srt #755).
  assert.deepEqual(c.filesystem.denyRead, [
    { path: "/", literal: true },
    { path: "/home/u", literal: true },
    ...DARWIN_CREDENTIALS,
  ]);
  // Workspace, the darwin system read set, then the init read roots. No /Users, /Library,
  // /private/var/db, /private/var/folders, /Volumes.
  assert.deepEqual(c.filesystem.allowRead, [
    { path: "/home/u/ws", literal: true },
    ...literals(DARWIN_SYSTEM),
    { path: "/home/u/.nvm/versions/node/v22.1.0", literal: true },
  ]);
  const allowed = pathsOf(c.filesystem.allowRead);
  for (const forbidden of [
    "/Users",
    "/Library",
    "/private/var/db",
    "/private/var/folders",
    "/Volumes",
  ])
    assert.ok(!allowed.includes(forbidden), `${forbidden} must not be re-allowed`);
  // The credential paths are unwritable too (a granted $HOME must not let a command overwrite a
  // key or plant authorized_keys); they follow the srt temp dir entries.
  assert.deepEqual(c.filesystem.denyWrite, [
    { path: "/tmp/claude", literal: true },
    { path: "/private/tmp/claude", literal: true },
    ...DARWIN_CREDENTIALS,
  ]);
  // The darwin policy must not loosen any of the forbidden srt knobs either.
  for (const k of [
    "allowLocalBinding",
    "allowUnixSockets",
    "allowAllUnixSockets",
    "enableWeakerNestedSandbox",
    "allowAppleEvents",
  ])
    assert.ok(!(k in c) && !(k in c.network), `${k} must not be set`);
});

// Ruling R25: the credential files stay denied however home is spelled.
test("credential denies are absolute paths under home", () => {
  const c = buildConfig(validInit({ home: "/home/u/" }));
  const denied = pathsOf(c.filesystem.denyRead);
  assert.ok(denied.includes("/home/u/.cargo/credentials.toml"));
  for (const dir of [".ssh", ".aws", ".gnupg"]) assert.ok(denied.includes(`/home/u/${dir}`));
  assert.ok(denied.every((path) => !path.includes("//")));
});

// Linux: bubblewrap makes an empty placeholder on the host for every ABSENT denyWrite path under
// a writable root (a granted $HOME), so buildConfig adds none and perWrapWriteDenies adds only the
// credential paths that exist (checked per command), keeping the real home free of placeholders.
test("linux denyWrite: no credential paths statically, only existing ones inside the workspace per wrap", () => {
  const init = validInit({ home: "/home/u" });
  assert.deepEqual(buildConfig(init).filesystem.denyWrite, [{ path: "/tmp/claude", literal: true }]);
  const present = new Set(["/home/u/.ssh", "/home/u/.npmrc", "/home/u/.cargo/credentials.toml"]);
  const exists = (path: string) => present.has(path);
  // A granted $HOME workspace: the existing credential paths inside it are denied.
  assert.deepEqual(perWrapWriteDenies(init, "/home/u", exists), [
    "/home/u/.cargo/credentials.toml",
    "/home/u/.npmrc",
    "/home/u/.ssh",
  ]);
  assert.deepEqual(perWrapWriteDenies(init, "/home/u", () => false), []);
  // A workspace elsewhere (the cargo read root is not writable): bwrap would fail to bind a mount
  // point inside a read-only root, and a deny where nothing is writable protects nothing.
  assert.deepEqual(perWrapWriteDenies(init, "/home/u/project", exists), []);
  assert.deepEqual(perWrapWriteDenies(init, "/home/u/.cargo", exists), ["/home/u/.cargo/credentials.toml"]);
  assert.deepEqual(perWrapWriteDenies(init, "/home/u/.cargo/bin", exists), []);
  assert.deepEqual(perWrapWriteDenies(init, "/home/uu", exists), []);
  // Trailing-slash homes are spelled the same as in the read denies.
  assert.deepEqual(
    perWrapWriteDenies(validInit({ home: "/home/u/" }), "/home/u", (path) => path === "/home/u/.aws"),
    ["/home/u/.aws"],
  );
});

test("darwin has no per-wrap write denies: they are all static and unconditional", () => {
  assert.deepEqual(perWrapWriteDenies(validInit({ platform: "darwin", home: "/home/u" }), "/home/u", () => true), []);
});

// srt binds its bridge sockets from the sidecar's runtime directory before its filesystem
// mounts; on Linux exactly that directory is re-allowed so the "/" deny does not hide them.
test("linux re-allows the sidecar runtime directory, darwin does not", () => {
  const linux = buildConfig(validInit(), "/tmp/sourceweft-srt-abc");
  assert.ok(pathsOf(linux.filesystem.allowRead).includes("/tmp/sourceweft-srt-abc"));
  assert.ok(perWrapReadRoots(validInit(), "/tmp/sourceweft-srt-abc").includes("/tmp/sourceweft-srt-abc"));
  assert.ok(!pathsOf(linux.filesystem.allowRead).includes("/tmp"));
  assert.ok(
    !perWrapReadRoots(validInit({ platform: "darwin" }), "/tmp/x").includes("/tmp/x"),
  );
  assert.throws(() => buildConfig(validInit(), "relative"), PolicyInvalidError);
});

test("per-command write root is the workspace only", () =>
  assert.deepEqual(perCommandConfig("/home/u/ws [1]", []).filesystem?.allowWrite, [
    { path: "/home/u/ws [1]", literal: true },
  ]));

// Ruling R14: per command, only that command's workspace root plus the read roots are
// re-allowed inside the denied home — never the other init workspace roots.
test("per-command read roots are the workspace plus readRoots only", () =>
  assert.deepEqual(
    perCommandConfig("/home/u/ws [1]", ["/home/u/.cargo"]).filesystem?.allowRead,
    [
      { path: "/home/u/ws [1]", literal: true },
      { path: "/home/u/.cargo", literal: true },
    ],
  ));

// The in-sandbox helpers live in the (denied) bundle directory; exactly those two files are
// re-allowed, never the bundle directory, and ripgrep (host-side only) is not.
test("per-wrap read roots carve out exactly the in-sandbox helper files", () => {
  const init = validInit({
    helpers: {
      ripgrep: "/home/u/app/sandbox/current/rg",
      applySeccomp: "/home/u/app/sandbox/current/apply-seccomp",
      javaAgentJar: "/home/u/app/sandbox/current/srt-proxy-agent.jar",
    },
  });
  assert.deepEqual(perWrapReadRoots(init), [
    ...SYSTEM,
    "/home/u/.nvm/versions/node/v22.1.0",
    "/home/u/app/sandbox/current/apply-seccomp",
    "/home/u/app/sandbox/current/srt-proxy-agent.jar",
  ]);
  assert.deepEqual(perWrapReadRoots(validInit()), [
    ...SYSTEM,
    "/home/u/.nvm/versions/node/v22.1.0",
  ]);
  assert.deepEqual(perWrapReadRoots(validInit({ platform: "darwin" })), [
    ...DARWIN_SYSTEM,
    "/home/u/.nvm/versions/node/v22.1.0",
  ]);
});

// Ruling R16(c): extra read denies come after `home`, as literals; omitted means none.
test("denyRoots are added to denyRead as literals", () => {
  const c = buildConfig(
    validInit({ denyRoots: ["/home/u/.local/share/app/local-host", "/home/u/.local/share/app/sandbox"] }),
  );
  assert.deepEqual(c.filesystem.denyRead, [
    { path: "/", literal: true },
    { path: "/home/u", literal: true },
    { path: "/home/u/.local/share/app/local-host", literal: true },
    { path: "/home/u/.local/share/app/sandbox", literal: true },
    ...CREDENTIALS,
  ]);
  assert.deepEqual(buildConfig(validInit()).filesystem.denyRead, [
    { path: "/", literal: true },
    { path: "/home/u", literal: true },
    ...CREDENTIALS,
  ]);
});
test("rejects a relative denyRoots entry", () => {
  assert.throws(
    () => buildConfig(validInit({ denyRoots: ["local-host"] })),
    (error) => {
      assert.ok(error instanceof PolicyInvalidError);
      assert.equal(error.code, "POLICY_INVALID");
      return true;
    },
  );
});

// Ruling R7 (fix round 1 review): buildConfig must reject a non-absolute home,
// workspaceRoots[] or readRoots[] entry with a PolicyInvalidError (code POLICY_INVALID, the
// matching SidecarErrorCode).
test("rejects a relative home", () => {
  assert.throws(
    () => buildConfig(validInit({ home: "home/u" })),
    (error) => {
      assert.ok(error instanceof PolicyInvalidError);
      assert.equal(error.code, "POLICY_INVALID");
      return true;
    },
  );
});
test("rejects a relative workspaceRoots entry", () => {
  assert.throws(
    () => buildConfig(validInit({ workspaceRoots: ["ws"] })),
    (error) => {
      assert.ok(error instanceof PolicyInvalidError);
      assert.equal(error.code, "POLICY_INVALID");
      return true;
    },
  );
});
test("rejects a relative readRoots entry", () => {
  assert.throws(
    () => buildConfig(validInit({ readRoots: ["../ro"] })),
    (error) => {
      assert.ok(error instanceof PolicyInvalidError);
      assert.equal(error.code, "POLICY_INVALID");
      return true;
    },
  );
});
