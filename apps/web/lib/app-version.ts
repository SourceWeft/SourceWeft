// The web app has no meaningful semver of its own: apps/web/package.json has sat
// at 1.0.0 since it was created and is not tied to release tags. The deployed
// commit is the only identifier that is both unique per deploy and traceable.
export const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA || "dev";
export const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || "";
export const SHORT_BUILD_SHA = BUILD_SHA.slice(0, 7);
