import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { UPDATE_TARGETS } from "./desktop-update-manifest.mjs";
import { updatePublicationPolicy } from "./desktop-publication-policy.mjs";

export function releaseConfig(env) {
  const policy = updatePublicationPolicy(env.DESKTOP_PUBLICATION_POLICY);
  const require = (name) => {
    assert(
      env[name]?.trim(),
      `${name} is required for signed desktop releases`,
    );
    return env[name].trim();
  };
  const target = require("DESKTOP_RELEASE_TARGET");
  assert(UPDATE_TARGETS[target], "Unsupported release target");
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
  if (policy === "updater-signed") {
    // Explicit mode, never a catch-and-retry fallback. Reject ambient platform
    // signing inputs so the resulting distribution claims remain truthful.
    for (const key of Object.keys(env)) {
      if (
        (key.startsWith("APPLE_") ||
          key.startsWith("WINDOWS_CERTIFICATE") ||
          key === "WINDOWS_TIMESTAMP_URL") &&
        env[key]?.trim()
      )
        throw new Error(`${key} must be unset for updater-signed releases`);
    }
    // Ad-hoc signing preserves macOS executable integrity (including arm64),
    // but does not assert Developer ID identity or notarization.
    if (target.endsWith("apple-darwin"))
      config.bundle.macOS = { signingIdentity: "-" };
    return config;
  }
  if (target.endsWith("apple-darwin")) {
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
  } else if (target.endsWith("windows-msvc")) {
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
  await writeFile(
    "apps/desktop/src-tauri/tauri.release.generated.json",
    JSON.stringify(releaseConfig(process.env), null, 2),
  );
}
