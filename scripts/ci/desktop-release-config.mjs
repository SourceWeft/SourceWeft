import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { UPDATE_TARGETS } from "./desktop-update-manifest.mjs";

export function releaseConfig(env) {
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
