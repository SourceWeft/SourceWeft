import assert from "node:assert/strict";

export function desktopPublicationPolicy(value = "signed") {
  assert(
    ["signed", "updater-signed", "candidate"].includes(value),
    "Desktop publication policy must be signed, updater-signed or candidate",
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
  return {
    distributionSigned: policy === "signed" && platform !== "linux",
    notarized: policy === "signed" && platform === "macos",
  };
}
