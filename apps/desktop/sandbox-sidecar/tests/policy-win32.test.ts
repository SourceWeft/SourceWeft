import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCwdWithinWorkspace,
  assertWorkspaceRootAllowed,
  buildConfig,
  perWrapDenies,
  perWrapReadRoots,
  perWrapWriteDenies,
  PolicyInvalidError,
  protectedPaths,
} from "../src/policy.js";
import type { InitConfig } from "../src/protocol.js";

// Every Windows path operation in the policy runs on `node:path/win32`, so these tests (all
// Windows-shaped paths, no filesystem access) run unchanged on macOS and Linux.

const SRT_WIN = "C:\\Program Files\\SourceWeft\\sandbox\\srt-win.exe";
const SHELL = "C:\\Program Files\\Git\\bin\\bash.exe";

function winInit(overrides: Partial<InitConfig> = {}): InitConfig {
  return {
    platform: "win32",
    home: "C:\\Users\\u",
    workspaceRoots: ["C:\\Users\\u\\ws"],
    readRoots: ["C:\\Users\\u\\.cargo\\bin"],
    helpers: { ripgrep: "C:\\app\\sandbox\\rg.exe" },
    windows: { srtWin: SRT_WIN, shell: SHELL },
    ...overrides,
  };
}

function assertPolicyInvalid(fn: () => unknown): void {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof PolicyInvalidError, String(error));
    assert.equal(error.code, "POLICY_INVALID");
    return true;
  });
}

const pathsOf = (entries: ReadonlyArray<string | { path: string }> | undefined): string[] =>
  (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));

test("win32 config: no blanket deny, one session write grant, read roots literal, namespace constants", () => {
  const c = buildConfig(winInit());
  // Reads are bounded by NTFS ACLs: no `/`, drive or profile deny (a deny on an inherited tree
  // stamps ACEs across the volume, and an absent deny path creates a placeholder).
  assert.deepEqual(c.filesystem.denyRead, []);
  assert.deepEqual(c.filesystem.denyWrite, []);
  assert.deepEqual(c.filesystem.allowRead, [{ path: "C:\\Users\\u\\.cargo\\bin", literal: true }]);
  // The one session-level write grant is the workspace; a per-command grant would throw in srt.
  assert.deepEqual(c.filesystem.allowWrite, [{ path: "C:\\Users\\u\\ws", literal: true }]);
  assert.equal(c.filesystem.allowGitConfig, true);
  assert.deepEqual(c.windows, {
    srtWin: { path: SRT_WIN },
    sandboxUser: "sourceweft-sandbox",
    proxyPortRange: [60180, 60189],
  });
  // The sublayer GUID is the build's compile-time default: never set here.
  assert.ok(!("sublayerGuid" in (c.windows ?? {})));
  assert.ok(!("wfpSublayerGuid" in (c.windows ?? {})));
  assert.equal(c.ripgrep?.command, "C:\\app\\sandbox\\rg.exe");
  assert.deepEqual(c.network.allowedDomains, []);
  assert.ok(c.network.deniedResolvedAddresses?.includes("10.0.0.0/8"));
  for (const k of [
    "allowLocalBinding",
    "allowUnixSockets",
    "allowAllUnixSockets",
    "enableWeakerNestedSandbox",
    "allowAppleEvents",
  ])
    assert.ok(!(k in c) && !(k in c.network), `${k} must not be set`);
  // No Linux/macOS-only fields leak into the Windows config.
  assert.ok(!("bwrapPath" in c) && !("seccomp" in c) && !("javaAgentJarPath" in c));
});

test("win32 config never lists a root, home or drive deny, and ignores the posix tmp deny", () => {
  const c = buildConfig(winInit({ denyRoots: ["C:\\Users\\u\\AppData\\Roaming\\app\\local-host"] }));
  assert.deepEqual(c.filesystem.denyRead, []);
  assert.deepEqual(c.filesystem.denyWrite, []);
});

test("win32 init with other than exactly one workspace root is POLICY_INVALID", () => {
  assertPolicyInvalid(() => buildConfig(winInit({ workspaceRoots: [] })));
  assertPolicyInvalid(() =>
    buildConfig(winInit({ workspaceRoots: ["C:\\Users\\u\\a", "C:\\Users\\u\\b", "C:\\Users\\u\\c"] })),
  );
  assertPolicyInvalid(() => buildConfig(winInit({ workspaceRoots: ["C:\\Users\\u\\a", "C:\\Users\\u\\b"] })));
});

test("win32 init needs the windows block, with an absolute srtWin and shell", () => {
  assertPolicyInvalid(() => buildConfig(winInit({ windows: undefined })));
  assertPolicyInvalid(() => buildConfig(winInit({ windows: { srtWin: "srt-win.exe", shell: SHELL } })));
  assertPolicyInvalid(() => buildConfig(winInit({ windows: { srtWin: SRT_WIN, shell: "bash.exe" } })));
  assertPolicyInvalid(() => buildConfig(winInit({ windows: { srtWin: "", shell: SHELL } })));
  assertPolicyInvalid(() =>
    buildConfig(winInit({ windows: { srtWin: SRT_WIN, shell: "\\\\srv\\share\\bash.exe" } })),
  );
});

test("the windows block is only valid on win32", () => {
  const windows = { srtWin: SRT_WIN, shell: SHELL };
  assertPolicyInvalid(() =>
    buildConfig({
      platform: "linux",
      home: "/home/u",
      workspaceRoots: ["/home/u/ws"],
      readRoots: [],
      helpers: { ripgrep: "/opt/sw/rg" },
      windows,
    }),
  );
  assertPolicyInvalid(() =>
    buildConfig({
      platform: "darwin",
      home: "/Users/u",
      workspaceRoots: ["/Users/u/ws"],
      readRoots: [],
      helpers: { ripgrep: "/opt/sw/rg" },
      windows,
    }),
  );
});

test("win32 init rejects relative, root-relative, drive-relative, UNC and device paths", () => {
  const bad = [
    "ws",
    "..\\ws",
    "\\ws",
    "/ws",
    "C:ws",
    "\\\\srv\\share\\ws",
    "//srv/share/ws",
    "\\\\?\\C:\\Users\\u\\ws",
    "\\\\.\\C:\\Users\\u\\ws",
    "//?/C:/Users/u/ws",
    "\\\\?\\UNC\\srv\\share\\ws",
  ];
  for (const path of bad) {
    assertPolicyInvalid(() => buildConfig(winInit({ workspaceRoots: [path] })));
    assertPolicyInvalid(() => buildConfig(winInit({ home: path })));
    assertPolicyInvalid(() => buildConfig(winInit({ readRoots: [path] })));
    assertPolicyInvalid(() => buildConfig(winInit({ denyRoots: [path] })));
    assertPolicyInvalid(() => buildConfig(winInit({ windows: { srtWin: path, shell: SHELL } })));
  }
});

test("win32 init accepts forward-slash drive paths (the wire form) and keeps them literal", () => {
  const c = buildConfig(
    winInit({
      home: "C:/Users/u",
      workspaceRoots: ["c:/Users/u/ws [1]"],
      readRoots: ["D:/tools/node"],
    }),
  );
  assert.deepEqual(c.filesystem.allowWrite, [{ path: "c:/Users/u/ws [1]", literal: true }]);
  assert.deepEqual(c.filesystem.allowRead, [{ path: "D:/tools/node", literal: true }]);
});

test("win32 per-wrap read roots are exactly the init read roots", () => {
  assert.deepEqual(perWrapReadRoots(winInit()), ["C:\\Users\\u\\.cargo\\bin"]);
  // The helper files that Linux carves out of its deny are not read inside the Windows sandbox.
  assert.deepEqual(
    perWrapReadRoots(
      winInit({
        readRoots: [],
        helpers: { ripgrep: "C:\\a\\rg.exe", javaAgentJar: "C:\\a\\srt-proxy-agent.jar" },
      }),
    ),
    [],
  );
});

test("protectedPaths: denyRoots, then the credential stores under home", () => {
  const paths = protectedPaths(
    winInit({ home: "C:\\Users\\u", denyRoots: ["C:\\Users\\u\\AppData\\Roaming\\app\\local-host"] }),
  );
  assert.equal(paths[0], "C:\\Users\\u\\AppData\\Roaming\\app\\local-host");
  const expected = [
    ".ssh",
    ".aws",
    ".azure",
    ".kube",
    ".gnupg",
    ".oci",
    ".terraform.d",
    ".claude",
    ".codex",
    ".docker\\config.json",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".pgpass",
    ".git-credentials",
    ".cargo\\credentials",
    ".cargo\\credentials.toml",
    ".m2\\settings.xml",
    ".gradle\\gradle.properties",
    ".nuget\\NuGet.Config",
    ".config\\gh",
    ".config\\gcloud",
    ".config\\git\\credentials",
    ".config\\rclone",
    ".config\\op",
    ...[
      "gcloud",
      "GitHub CLI",
      "gnupg",
      "Microsoft\\Credentials",
      "Microsoft\\Protect",
      "Microsoft\\Vault",
      "Microsoft\\Crypto",
      "Microsoft\\SystemCertificates",
      "Mozilla",
      "1Password",
      "Bitwarden",
      "KeePass",
      "Code\\User\\globalStorage",
      "npm\\etc\\npmrc",
    ].map((name) => `AppData\\Roaming\\${name}`),
    ...[
      "Microsoft\\Credentials",
      "Microsoft\\Vault",
      "Microsoft\\IdentityCache",
      "Microsoft\\TokenBroker",
      "Google\\Chrome\\User Data",
      "Microsoft\\Edge\\User Data",
      "BraveSoftware\\Brave-Browser\\User Data",
      "Packages",
    ].map((name) => `AppData\\Local\\${name}`),
  ].map((relative) => `C:\\Users\\u\\${relative}`);
  assert.deepEqual(paths.slice(1), expected);
});

test("protectedPaths spells home the same however it is written", () => {
  for (const home of ["C:\\Users\\u\\", "C:/Users/u", "C:/Users/u/"]) {
    const paths = protectedPaths(winInit({ home }));
    assert.ok(paths.includes("C:\\Users\\u\\.ssh"), home);
    assert.ok(paths.every((path) => !path.includes("/") && !path.includes("\\\\")), home);
  }
});

// A deny where nothing is readable protects nothing, an absent deny path makes srt-win create a
// placeholder on the host, and a deny on a path outside every granted root only stamps ACEs.
test("perWrapDenies: only existing protected paths inside the workspace or a read root", () => {
  const init = winInit({
    home: "C:\\Users\\u",
    workspaceRoots: ["C:\\Users\\u"],
    readRoots: ["C:\\Users\\u\\.cargo\\bin", "D:\\tools"],
  });
  const present = new Set([
    "C:\\Users\\u\\.ssh",
    "C:\\Users\\u\\.npmrc",
    "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Credentials",
    "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data",
  ]);
  const exists = (path: string) => present.has(path);
  // A granted profile: every existing protected path inside it is denied.
  assert.deepEqual(perWrapDenies(init, "C:\\Users\\u", exists), [
    "C:\\Users\\u\\.ssh",
    "C:\\Users\\u\\.npmrc",
    "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Credentials",
    "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data",
  ]);
  // Nothing exists: nothing is denied (and so nothing is created).
  assert.deepEqual(perWrapDenies(init, "C:\\Users\\u", () => false), []);
});

test("perWrapDenies: a workspace elsewhere is not denied anything outside it or a read root", () => {
  const init = winInit({
    home: "C:\\Users\\u",
    workspaceRoots: ["D:\\proj"],
    readRoots: ["C:\\Users\\u\\.cargo\\bin"],
  });
  const exists = () => true;
  assert.deepEqual(perWrapDenies(init, "D:\\proj", exists), []);
  // Inside a read root: a credential file below the root is denied for read and write.
  const cargo = winInit({
    home: "C:\\Users\\u",
    workspaceRoots: ["D:\\proj"],
    readRoots: ["C:\\Users\\u\\.cargo"],
  });
  assert.deepEqual(perWrapDenies(cargo, "D:\\proj", exists), [
    "C:\\Users\\u\\.cargo\\credentials",
    "C:\\Users\\u\\.cargo\\credentials.toml",
  ]);
  // A sibling that merely shares a prefix is not inside.
  assert.deepEqual(
    perWrapDenies(winInit({ readRoots: [], workspaceRoots: ["C:\\Users\\u\\.ss"] }), "C:\\Users\\u\\.ss", exists),
    [],
  );
  assert.deepEqual(
    perWrapDenies(winInit({ readRoots: [], workspaceRoots: ["C:\\Users\\uu"] }), "C:\\Users\\uu", exists),
    [],
  );
});

test("perWrapDenies compares case-insensitively and across slash styles", () => {
  // Home is spelled one way, the workspace another: they are the same directory on Windows.
  const init = winInit({ home: "c:/users/U/ws", workspaceRoots: ["C:\\USERS\\u\\WS"], readRoots: [] });
  const denies = perWrapDenies(init, "C:/Users/u/ws", () => true);
  assert.ok(denies.includes("c:\\users\\U\\ws\\.ssh"));
  assert.ok(denies.includes("c:\\users\\U\\ws\\AppData\\Local\\Packages"));
  // A home above the workspace: its credential paths are outside it.
  const above = winInit({ home: "C:\\Users\\U", workspaceRoots: ["c:/users/u/ws"], readRoots: [] });
  assert.deepEqual(perWrapDenies(above, "c:/users/u/ws", () => true), []);
});

test("perWrapDenies includes denyRoots that exist inside the workspace", () => {
  const init = winInit({
    home: "C:\\Users\\u",
    workspaceRoots: ["C:\\Users\\u"],
    readRoots: [],
    denyRoots: ["C:\\Users\\u\\AppData\\Roaming\\app\\local-host", "D:\\elsewhere\\db"],
  });
  const denies = perWrapDenies(init, "C:\\Users\\u", (path) => path.endsWith("local-host") || path.endsWith("db"));
  assert.deepEqual(denies, ["C:\\Users\\u\\AppData\\Roaming\\app\\local-host"]);
});

test("win32 has no per-wrap write-deny list of its own (perWrapDenies covers read and write)", () => {
  assert.deepEqual(perWrapWriteDenies(winInit(), "C:\\Users\\u\\ws", () => true), []);
});

test("win32 workspaceRoot and cwd are checked case-insensitively with win32 semantics", () => {
  const roots = ["C:\\Users\\u\\ws"];
  assert.equal(assertWorkspaceRootAllowed("c:/users/U/ws", roots, "win32"), "c:\\users\\U\\ws");
  assert.equal(assertWorkspaceRootAllowed("C:\\Users\\u\\ws\\sub\\..\\sub2", roots, "win32"), "C:\\Users\\u\\ws\\sub2");
  assertPolicyInvalid(() => assertWorkspaceRootAllowed("C:\\Users\\u\\wsx", roots, "win32"));
  assertPolicyInvalid(() => assertWorkspaceRootAllowed("C:\\Users\\u\\ws\\..\\other", roots, "win32"));
  assertPolicyInvalid(() => assertWorkspaceRootAllowed("D:\\Users\\u\\ws", roots, "win32"));
  assertPolicyInvalid(() => assertWorkspaceRootAllowed("ws", roots, "win32"));
  assertPolicyInvalid(() => assertWorkspaceRootAllowed("\\\\srv\\share\\ws", roots, "win32"));
  assertPolicyInvalid(() => assertWorkspaceRootAllowed("\\\\?\\C:\\Users\\u\\ws", roots, "win32"));

  assert.equal(assertCwdWithinWorkspace("C:/Users/U/ws/pkg", "C:\\Users\\u\\ws", "win32"), "C:\\Users\\U\\ws\\pkg");
  assert.equal(assertCwdWithinWorkspace("C:\\Users\\u\\ws", "C:\\Users\\u\\ws", "win32"), "C:\\Users\\u\\ws");
  assertPolicyInvalid(() => assertCwdWithinWorkspace("C:\\Users\\u", "C:\\Users\\u\\ws", "win32"));
  assertPolicyInvalid(() => assertCwdWithinWorkspace("C:\\Users\\u\\ws\\..\\x", "C:\\Users\\u\\ws", "win32"));
  assertPolicyInvalid(() => assertCwdWithinWorkspace("pkg", "C:\\Users\\u\\ws", "win32"));
});

test("a drive root workspace is accepted by the policy (the host refuses to register one)", () => {
  assert.equal(assertWorkspaceRootAllowed("D:\\", ["D:\\"], "win32"), "D:\\");
  assert.equal(assertCwdWithinWorkspace("D:\\x", "D:\\", "win32"), "D:\\x");
});

test("the allow lists in the win32 config carry only paths that pass the same validation", () => {
  const c = buildConfig(winInit());
  for (const path of [...pathsOf(c.filesystem.allowRead), ...pathsOf(c.filesystem.allowWrite)])
    assert.match(path, /^[A-Za-z]:[\\/]/);
});

// A root inside a protected path is granted with no deny at all (the per-command deny list only
// covers protected paths INSIDE a root), so the policy refuses it outright.
test("win32 init refuses a workspace root that is or lies inside a protected path", () => {
  for (const root of [
    "C:\\Users\\u\\.ssh",
    "C:\\Users\\u\\.ssh\\proj",
    "c:/users/U/.SSH/proj/",
    "C:\\Users\\u\\.claude\\worktrees\\x",
    "C:\\Users\\u\\.codex",
    "C:\\Users\\u\\.config\\op\\x",
    "C:\\Users\\u\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x",
    "C:\\Users\\u\\AppData\\Roaming\\Code\\User\\globalStorage",
    "C:\\Users\\u\\AppData\\Roaming\\npm\\etc\\npmrc",
    "C:\\Users\\u\\AppData\\Local\\Packages\\Pkg\\LocalState",
  ]) {
    assertPolicyInvalid(() => buildConfig(winInit({ workspaceRoots: [root] })));
  }
  assert.throws(
    () => buildConfig(winInit({ workspaceRoots: ["C:\\Users\\u\\.ssh\\proj"] })),
    /workspaceRoots\[0\].*protected location/,
  );
});

test("win32 init refuses a read root that is or lies inside a protected path", () => {
  for (const root of [
    "C:\\Users\\u\\.ssh\\bin",
    "C:\\Users\\u\\AppData\\Local\\Packages\\Python.3.11\\LocalCache\\Scripts",
    "C:\\Users\\u\\AppData\\Roaming\\Mozilla",
  ]) {
    assertPolicyInvalid(() => buildConfig(winInit({ readRoots: [root] })));
  }
});

test("win32 init accepts roots next to, above or elsewhere than the protected paths", () => {
  for (const root of [
    "C:\\Users\\u\\.sshx",
    "C:\\Users\\u\\.claude-notes",
    "C:\\Users\\u\\AppData\\Roaming\\npm",
    "C:\\Users\\u\\AppData\\Roaming\\Code\\User",
    "C:\\Users\\u\\AppData\\Local\\Temp\\ws",
    "C:\\Users\\u\\Documents\\proj",
    "C:\\Users\\u",
    "D:\\Users\\u\\.ssh",
    "C:\\Users\\v\\.ssh\\proj",
  ]) {
    buildConfig(winInit({ workspaceRoots: [root] }));
    buildConfig(winInit({ readRoots: [root] }));
  }
});

test("the host's scratch probe workspace below a denyRoot is not a protected-path violation", () => {
  const c = buildConfig(
    winInit({
      workspaceRoots: ["C:\\Users\\u\\AppData\\Roaming\\app\\sandbox\\probe"],
      denyRoots: ["C:\\Users\\u\\AppData\\Roaming\\app\\sandbox"],
    }),
  );
  assert.deepEqual(pathsOf(c.filesystem.allowWrite), ["C:\\Users\\u\\AppData\\Roaming\\app\\sandbox\\probe"]);
});
