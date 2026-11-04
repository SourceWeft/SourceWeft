/**
 * Pure helpers for `build.ts`: the bundle `manifest.json`, the Rust target triple it names, the
 * required-Bun-version guard and the `bun build --compile` argument vector. Kept free of Bun APIs
 * and of any build side effect so the sidecar tests can import and run them under tsx without
 * compiling a bundle.
 *
 * The manifest wire shape is fixed by Plan 2 ("Wire contracts"): the Rust installer
 * (`bundle_install.rs`) and `scripts/ci/sandbox-bundle.mjs` read exactly this.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_FILENAME = "manifest.json";

/**
 * The exact Bun release the bundle is built and tested with (CI pins the same one). Older Bun
 * releases break srt's proxy (the design's Global Constraints), and — the trap this guard exists
 * to stop (E2E finding) — a Bun older than 1.4 silently compiles a sidecar whose `init` never
 * replies. `build.ts` compiles with `process.execPath` (the very Bun that runs the script), so
 * pinning the running Bun's version here pins the compiler too.
 */
export const REQUIRED_BUN_VERSION = "1.4.2";

/**
 * Throws unless `version` (passed `process.versions.bun`) is exactly `REQUIRED_BUN_VERSION`. The
 * message names both the found version and the requirement so a wrong Bun fails loudly instead of
 * producing a bundle nobody tested; `undefined` (the script was run with node, not Bun, so there is
 * no `process.versions.bun`) is reported as `no Bun`.
 */
export function assertBunVersion(version: string | undefined): void {
  if (version !== REQUIRED_BUN_VERSION) {
    throw new Error(
      `the sidecar bundle must be built with Bun ${REQUIRED_BUN_VERSION}, got ${version ?? "no Bun (run with bun)"}`,
    );
  }
}

/**
 * The argument vector `build.ts` passes to the Bun it is running under (`process.execPath`) to
 * compile the sidecar — everything after argv[0]. `crossTarget` is the `bun build --target` value
 * for a same-OS cross-architecture build (from `bunCompileTarget`), or `undefined` for a native
 * build, which omits `--target` and so stays byte-identical to the historical Linux compile.
 * Pure string construction, with no Bun API or filesystem touch, so a test pins the exact command.
 */
export function bunCompileArgs(input: {
  entry: string;
  outFile: string;
  crossTarget: string | undefined;
}): string[] {
  return [
    "build",
    "--compile",
    ...(input.crossTarget ? [`--target=${input.crossTarget}`] : []),
    "--define",
    '__SRT_WIN_NAMESPACE__="sourceweft"',
    input.entry,
    "--outfile",
    input.outFile,
  ];
}

/**
 * The pinned SHA-256 of the fork's `srt-win.exe` per Windows target (`srt-win-pin.json`, beside
 * `package.json`). The desktop app embeds the same file and its elevated setup runs only a file
 * with exactly this hash, so the bundle must carry the unmodified, unsigned file of the pinned
 * fork tag. The build asserts it (`assertSrtWinMatchesPin`), as does `verify-windows-bundle.ps1`.
 */
export const SRT_WIN_PIN_FILENAME = "srt-win-pin.json";

export type SrtWinPin = { tag: string; srtWin: Record<string, string> };

/** Parses the pin text; anything but a non-empty tag and lowercase 64-hex hashes is an error. */
export function parseSrtWinPin(text: string): SrtWinPin {
  const value: unknown = JSON.parse(text);
  const pin = value as { tag?: unknown; srtWin?: unknown };
  if (typeof pin.tag !== "string" || pin.tag === "") {
    throw new Error("the srt-win pin has no tag");
  }
  if (typeof pin.srtWin !== "object" || pin.srtWin === null || Array.isArray(pin.srtWin)) {
    throw new Error("the srt-win pin has no srtWin table");
  }
  const entries = Object.entries(pin.srtWin as Record<string, unknown>);
  if (entries.length === 0) throw new Error("the srt-win pin lists no target");
  for (const [target, hash] of entries) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`the srt-win pin for ${target} is not a lowercase SHA-256`);
    }
  }
  return { tag: pin.tag, srtWin: pin.srtWin as Record<string, string> };
}

/** The committed pin of this package. */
export function readSrtWinPin(): SrtWinPin {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", SRT_WIN_PIN_FILENAME);
  return parseSrtWinPin(readFileSync(path, "utf8"));
}

/**
 * Throws unless `actualSha256` (the bundled `srt-win.exe`) is the pinned hash for `target`.
 * The usual cause of a mismatch is Authenticode signing, which rewrites the file; the other is a
 * dependency bump without a new pin.
 */
export function assertSrtWinMatchesPin(
  target: string,
  actualSha256: string,
  pin: SrtWinPin,
): void {
  const pinned = pin.srtWin[target];
  if (pinned === undefined) {
    throw new Error(`no srt-win.exe pin for ${target} in ${SRT_WIN_PIN_FILENAME}`);
  }
  if (actualSha256.toLowerCase() !== pinned) {
    throw new Error(
      `srt-win.exe for ${target} has sha256 ${actualSha256.toLowerCase()}, but ${SRT_WIN_PIN_FILENAME} pins ${pinned} (fork ${pin.tag}). ` +
        "It must be the unmodified, unsigned file of that release (Authenticode signing changes it); after a dependency bump, update the pin.",
    );
  }
}

export type Manifest = {
  schemaVersion: 1;
  protocolVersion: number;
  appVersion: string;
  target: string;
  srtVersion: string;
  files: Record<string, { sha256: string; size: number }>;
};

/** Build host (`process.platform`/`process.arch`) -> the Rust triple the bundle is compiled for. */
const HOST_TARGETS: Record<string, string> = {
  "linux/x64": "x86_64-unknown-linux-gnu",
  "linux/arm64": "aarch64-unknown-linux-gnu",
  "darwin/x64": "x86_64-apple-darwin",
  "darwin/arm64": "aarch64-apple-darwin",
  "win32/x64": "x86_64-pc-windows-msvc",
  "win32/arm64": "aarch64-pc-windows-msvc",
};

/** Rust triple -> the `bun build --compile --target` value that produces it. */
export const BUN_COMPILE_TARGETS: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
};

const osOf = (triple: string): string => {
  if (triple.endsWith("-apple-darwin")) return "darwin";
  if (triple.includes("-linux-")) return "linux";
  if (triple.endsWith("-pc-windows-msvc")) return "windows";
  throw new Error(`cannot determine OS of target ${triple}`);
};

/** Rust triple -> the architecture directory name srt's `vendor/` uses (`x64` or `arm64`). */
function vendorArchOf(triple: string): "x64" | "arm64" {
  if (triple.startsWith("x86_64-")) return "x64";
  if (triple.startsWith("aarch64-")) return "arm64";
  throw new Error(`cannot determine the architecture of target ${triple}`);
}

export type BundlePlan = {
  /** The compiled sidecar's file name in the bundle (`.exe` on Windows). */
  sidecarName: string;
  /** The ripgrep file name in the bundle (the binary itself comes from `--rg`). */
  rgName: string;
  /**
   * Files copied verbatim out of the installed srt package, as `from` (relative to the sidecar
   * package root, POSIX separators) -> `to` (file name in the bundle).
   */
  vendorCopies: { from: string; to: string; executable: boolean }[];
  /** Whether `rg` gets mode 0755 (false on Windows, which has no exec bit). */
  setExecBit: boolean;
};

const VENDOR = "node_modules/@anthropic-ai/sandbox-runtime/vendor";

/**
 * Everything that differs between the three bundle flavours, decided from the Rust target alone
 * (never from the host), as pure data so it is testable without a Windows machine. Linux adds
 * srt's `apply-seccomp`; macOS has no extra helper (Seatbelt); Windows adds srt's `srt-win.exe`
 * (the broker and the sandbox-account runner), takes `.exe` names and has no seccomp. The helper
 * is taken from the target architecture's vendor directory: it must match the bundle.
 */
export function bundlePlan(target: string): BundlePlan {
  if (!Object.values(HOST_TARGETS).includes(target)) {
    throw new Error(`${target} is not a supported bundle target`);
  }
  const os = osOf(target);
  const arch = vendorArchOf(target);
  const jar = {
    from: `${VENDOR}/java-proxy-agent/srt-proxy-agent.jar`,
    to: "srt-proxy-agent.jar",
    executable: false,
  };
  if (os === "windows") {
    return {
      sidecarName: "srt-sidecar.exe",
      rgName: "rg.exe",
      vendorCopies: [
        {
          from: `${VENDOR}/srt-win/${arch}/srt-win.exe`,
          to: "srt-win.exe",
          executable: false,
        },
        jar,
      ],
      setExecBit: false,
    };
  }
  return {
    sidecarName: "srt-sidecar",
    rgName: "rg",
    vendorCopies:
      os === "linux"
        ? [
            {
              from: `${VENDOR}/seccomp/${arch}/apply-seccomp`,
              to: "apply-seccomp",
              executable: true,
            },
            jar,
          ]
        : [jar],
    setExecBit: true,
  };
}

/**
 * The bundle is compiled by Bun. The OS must be the build host's OS: Bun can cross-compile
 * between architectures of the same OS (it downloads the target runtime) but we never ship a
 * Linux binary built on macOS or vice versa, and the ripgrep and signing legs are per OS.
 * `--target` is required except on Linux x64 (the original release leg); there is no guessing
 * for any other host, and a triple that is unknown or not this host's OS is refused.
 *
 * Within the same OS a cross-architecture target is allowed (macOS release builds x86_64 on the
 * arm64 runner exactly as the Tauri installers do). When the target architecture differs from
 * the host, `bunCompileTarget` returns the `bun --target` to pass so the compile is explicit;
 * for a native build it returns undefined and the compile stays byte-identical to before.
 */
export function resolveTarget(
  explicit: string | undefined,
  platform: string,
  arch: string,
): string {
  const host = HOST_TARGETS[`${platform}/${arch}`];
  if (explicit === undefined) {
    if (host === "x86_64-unknown-linux-gnu") return host;
    throw new Error(
      `--target <rust triple> is required on ${platform}/${arch} (it is optional only on linux/x64)`,
    );
  }
  if (!Object.values(HOST_TARGETS).includes(explicit)) {
    throw new Error(`--target ${explicit} is not a supported bundle target`);
  }
  if (host === undefined || osOf(explicit) !== osOf(host)) {
    throw new Error(
      `--target ${explicit} is not for the build host OS ${platform}/${arch}; the sidecar is compiled for the host OS only`,
    );
  }
  return explicit;
}

/**
 * The `bun build --compile --target` to pass for a given resolved target on a given host, or
 * undefined for a native build (same architecture), which compiles with no `--target` and is
 * therefore byte-identical to the historical Linux-x64 build. Cross-architecture builds within
 * the same OS pass the explicit Bun target. Callers must have validated the pair with
 * `resolveTarget` first.
 */
export function bunCompileTarget(
  target: string,
  platform: string,
  arch: string,
): string | undefined {
  const host = HOST_TARGETS[`${platform}/${arch}`];
  if (host === target) return undefined;
  const bunTarget = BUN_COMPILE_TARGETS[target];
  if (bunTarget === undefined) {
    throw new Error(`no bun --compile target for ${target}`);
  }
  return bunTarget;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function buildManifest(input: {
  bundleDir: string;
  protocolVersion: number;
  appVersion: string;
  target: string;
  srtVersion: string;
}): Manifest {
  if (!Number.isInteger(input.protocolVersion) || input.protocolVersion < 1) {
    throw new Error(`invalid protocolVersion ${String(input.protocolVersion)}`);
  }
  if (!SEMVER.test(input.appVersion))
    throw new Error(`invalid appVersion ${input.appVersion}`);
  if (!SEMVER.test(input.srtVersion))
    throw new Error(`invalid srtVersion ${JSON.stringify(input.srtVersion)}`);

  const names = readdirSync(input.bundleDir)
    .filter((name) => name !== MANIFEST_FILENAME)
    .sort();
  if (names.length === 0)
    throw new Error(`no files in bundle directory ${input.bundleDir}`);
  const files: Manifest["files"] = {};
  for (const name of names) {
    const path = join(input.bundleDir, name);
    if (!lstatSync(path).isFile()) {
      throw new Error(`bundle entry ${name} is not a regular file`);
    }
    const bytes = readFileSync(path);
    files[name] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }
  return {
    schemaVersion: 1,
    protocolVersion: input.protocolVersion,
    appVersion: input.appVersion,
    target: input.target,
    srtVersion: input.srtVersion,
    files,
  };
}
