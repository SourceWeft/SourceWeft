/**
 * The renderer/browser version pair, pinned together on purpose.
 *
 * `@remotion/renderer` is only correct with the Chrome Headless Shell build it
 * was tested against; letting either float independently is how "the image has
 * a browser but the renderer wants another" incidents happen. One review must
 * see both move (docs/architecture/sandbox-runtime-assets.md, A3). The sandbox
 * project install pins to REMOTION_RENDERER_VERSION exactly — never a range.
 */
export const REMOTION_RENDERER_VERSION = "4.0.468";

/**
 * Environment variable through which a staged browser reaches the generated
 * render scripts. Set per command invocation by `runProjectInSession`; the
 * scripts fall back to Remotion's own download (with retries) when unset.
 */
export const REMOTION_BROWSER_ENV_VAR = "SOURCEWEFT_REMOTION_BROWSER";

/**
 * chrome-headless-shell as a platform runtime asset
 * (docs/architecture/sandbox-runtime-assets.md). Declared by this feature,
 * served by the platform cache: sandboxes fetch the platform's verified copy,
 * never the upstream CDN, on the happy path.
 *
 * sha256 computed from the upstream zip on 2026-08-05; entrypoint is the
 * binary's path inside the unpacked archive.
 */
export const CHROME_HEADLESS_SHELL_ASSET = {
  name: "chrome-headless-shell",
  version: "149.0.7790.0",
  platform: "linux-x64",
  sha256: "a3b011ab4c726e215cdeb623907a09cfb48f07054a7271fdda555ee2ae4f804d",
  archive: "zip",
  entrypoint: "chrome-headless-shell-linux64/chrome-headless-shell",
  sizeBytes: 191_850_000,
  // Image rung (primary path): the sandbox image bakes the browser and sets
  // this env to its absolute path; the ladder's other rungs are insurance.
  imagePathEnvVar: REMOTION_BROWSER_ENV_VAR,
  upstreamUrls: [
    "https://storage.googleapis.com/chrome-for-testing-public/149.0.7790.0/linux64/chrome-headless-shell-linux64.zip",
  ],
} as const;
