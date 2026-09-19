import { appendFileSync } from "node:fs";
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

export function validateReleaseConfig(env) {
  const result = releaseVersion(env.GITHUB_REF_NAME);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = validateReleaseConfig(process.env);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `latest=${result.latest}\nprerelease=${result.prerelease}\n`,
    );
  console.log(
    `Release ${result.version} configuration passed (${result.prerelease ? "prerelease" : "stable"}).`,
  );
}
