import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { UPDATE_TARGETS } from "./desktop-update-manifest.mjs";
import {
  updatePublicationPolicy,
  distributionClaims,
} from "./desktop-publication-policy.mjs";

/**
 * `bundleOnly` validates the signing inputs for a target that has a sandbox runtime bundle but
 * no installer or updater package (Windows arm64): everything is checked exactly as for an
 * installer target except that the target need not be an update target.
 */
export function releaseConfig(env, { bundleOnly = false } = {}) {
  const policy = updatePublicationPolicy(env.DESKTOP_PUBLICATION_POLICY);
  const require = (name) => {
    assert(
      env[name]?.trim(),
      `${name} is required for signed desktop releases`,
    );
    return env[name].trim();
  };
  const target = require("DESKTOP_RELEASE_TARGET");
  assert(
    UPDATE_TARGETS[target] ||
      (bundleOnly && target === "aarch64-pc-windows-msvc"),
    "Unsupported release target",
  );
  const pubkey = require("TAURI_UPDATER_PUBLIC_KEY");
  require("TAURI_SIGNING_PRIVATE_KEY");
  const config = {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey,
        endpoints: ["https://download.sourceweft.com/updates/stable.json"],
        windows: { installMode: "passive" },
      },
    },
  };
  const platform = target.endsWith("apple-darwin")
    ? "macos"
    : target.endsWith("windows-msvc")
      ? "windows"
      : "linux";
  const { distributionSigned } = distributionClaims(policy, platform);
  if (policy !== "signed") {
    // Explicit modes, never a catch-and-retry fallback. Reject ambient signing inputs for
    // every platform this policy does not sign, so the resulting distribution claims remain
    // truthful: `updater-signed` signs nothing, `macos-signed` signs macOS targets only.
    for (const key of Object.keys(env)) {
      const apple = key.startsWith("APPLE_");
      const windows =
        key.startsWith("WINDOWS_CERTIFICATE") ||
        key === "WINDOWS_TIMESTAMP_URL";
      if ((windows || (apple && !distributionSigned)) && env[key]?.trim())
        throw new Error(
          policy === "updater-signed"
            ? `${key} must be unset for updater-signed releases`
            : `${key} must be unset for macos-signed releases on ${platform} targets`,
        );
    }
  }
  if (platform === "macos") {
    if (!distributionSigned) {
      // Ad-hoc signing preserves macOS executable integrity (including arm64),
      // but does not assert Developer ID identity or notarization.
      config.bundle.macOS = { signingIdentity: "-" };
      return config;
    }
    for (const key of [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
    ])
      require(key);
    const identity = require("APPLE_SIGNING_IDENTITY");
    assert(
      identity.startsWith("Developer ID Application:"),
      "macOS requires a Developer ID Application identity",
    );
    config.bundle.macOS = { signingIdentity: identity };
  } else if (platform === "windows" && distributionSigned) {
    const thumbprint = require("WINDOWS_CERTIFICATE_THUMBPRINT");
    assert(
      /^[a-fA-F0-9]{40}$/.test(thumbprint),
      "Invalid Windows certificate thumbprint",
    );
    config.bundle.windows = {
      certificateThumbprint: thumbprint,
      digestAlgorithm: "sha256",
      timestampUrl: require("WINDOWS_TIMESTAMP_URL"),
      tsp: true,
    };
  }
  return config;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes("--bundle-only")) {
    // Validation only: this target has no installer, so no installer config is written.
    releaseConfig(process.env, { bundleOnly: true });
  } else {
    await writeFile(
      "apps/desktop/src-tauri/tauri.release.generated.json",
      JSON.stringify(releaseConfig(process.env), null, 2),
    );
  }
}
