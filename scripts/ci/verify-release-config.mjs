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

export function validateReleaseConfig(env, metadata = {}) {
  const result = releaseVersion(env.GITHUB_REF_NAME);
  if (
    Object.hasOwn(metadata, "githubPrerelease") &&
    typeof metadata.githubPrerelease !== "boolean"
  ) {
    throw new Error("Changelog githubPrerelease must be a boolean.");
  }
  const desktopPolicy = Object.hasOwn(metadata, "desktopPublicationPolicy")
    ? metadata.desktopPublicationPolicy
    : "signed";
  if (!["signed", "candidate"].includes(desktopPolicy)) {
    throw new Error(
      "Changelog desktopPublicationPolicy must be signed or candidate.",
    );
  }
  if (desktopPolicy === "candidate" && !result.prerelease) {
    throw new Error(
      "Unsigned candidate installers require a semver prerelease version.",
    );
  }
  // GitHub's presentation flag is independent of semver update channels.
  // An RC can be a regular GitHub Release without advancing stable/latest.
  return {
    ...result,
    githubPrerelease: metadata.githubPrerelease ?? result.prerelease,
    desktopPolicy,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { version } = releaseVersion(process.env.GITHUB_REF_NAME);
  const metadata = JSON.parse(
    readFileSync(
      new URL(
        `../../apps/web/content/changelog/v${version}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (metadata.tag !== process.env.GITHUB_REF_NAME) {
    throw new Error("Changelog tag must match the release tag.");
  }
  const result = validateReleaseConfig(process.env, metadata);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `latest=${result.latest}\nprerelease=${result.githubPrerelease}\ndesktop_policy=${result.desktopPolicy}\n`,
    );
  console.log(
    `Release ${result.version} configuration passed (GitHub prerelease=${result.githubPrerelease}, latest=${result.latest}, desktop=${result.desktopPolicy}).`,
  );
}
