import assert from "node:assert/strict";

// `macos-signed` is an explicit mode for a release that has Apple credentials but no Windows
// publisher certificate: macOS is Developer ID signed and notarized, Windows stays unsigned
// exactly as in `updater-signed`. It is never inferred from which credentials are present.
export const DESKTOP_PUBLICATION_POLICIES = [
  "signed",
  "macos-signed",
  "updater-signed",
  "candidate",
];

export const DESKTOP_PUBLICATION_POLICY_MESSAGE =
  "Desktop publication policy must be signed, macos-signed, updater-signed or candidate";

export function desktopPublicationPolicy(value = "signed") {
  assert(
    DESKTOP_PUBLICATION_POLICIES.includes(value),
    DESKTOP_PUBLICATION_POLICY_MESSAGE,
  );
  return value;
}

export function updatePublicationPolicy(value = "signed") {
  const policy = desktopPublicationPolicy(value);
  assert(
    policy !== "candidate",
    "Candidate builds cannot publish application updates",
  );
  return policy;
}

export function distributionClaims(policy, platform) {
  desktopPublicationPolicy(policy);
  assert(
    ["macos", "windows", "linux"].includes(platform),
    "Invalid distribution platform",
  );
  const distributionSigned =
    (policy === "signed" && platform !== "linux") ||
    (policy === "macos-signed" && platform === "macos");
  return {
    distributionSigned,
    notarized: distributionSigned && platform === "macos",
  };
}
