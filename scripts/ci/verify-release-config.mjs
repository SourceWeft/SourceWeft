import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseVersion(tag) {
  const match =
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      tag ?? "",
    );
  if (
    !match ||
    match[0] !== tag ||
    match[4]?.split(".").some((part) => /^\d+$/.test(part) && /^0\d/.test(part))
  ) {
    throw new Error(
      "Release tag must be vMAJOR.MINOR.PATCH with an optional semver prerelease, without build metadata.",
    );
  }
  return {
    version: tag.slice(1),
    prerelease: Boolean(match[4]),
    latest: !match[4],
  };
}

export function requireReleaseUrl(name, value) {
  if (!value?.trim())
    throw new Error(`${name} must be explicitly configured for release.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "[::1]" ||
    host === "[::]" ||
    /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      host,
    );
  if (
    url.protocol !== "https:" ||
    privateHost ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must use a non-local HTTPS URL without credentials, query or fragment.`,
    );
  }
  return url.href;
}

export function validateReleaseConfig(env, desktopVersions = []) {
  const result = releaseVersion(env.GITHUB_REF_NAME);
  requireReleaseUrl("NEXT_PUBLIC_API_BASE_URL", env.NEXT_PUBLIC_API_BASE_URL);
  requireReleaseUrl("NEXT_PUBLIC_WEB_BASE_URL", env.NEXT_PUBLIC_WEB_BASE_URL);
  for (const version of desktopVersions) {
    if (version !== result.version)
      throw new Error(
        `Desktop version ${version} does not match release ${result.version}. Update Cargo.toml and tauri.conf.json before tagging.`,
      );
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const tauri = JSON.parse(
    readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"),
  );
  const cargo = readFileSync("apps/desktop/src-tauri/Cargo.toml", "utf8");
  const version = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  const result = validateReleaseConfig(process.env, [tauri.version, version]);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `latest=${result.latest}\nprerelease=${result.prerelease}\n`,
    );
  console.log(
    `Release ${result.version} configuration passed (${result.prerelease ? "prerelease" : "stable"}).`,
  );
}
