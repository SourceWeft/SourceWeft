import { expect, test } from "vitest";
import {
  hasInstallIntent,
  resolveInstallIntent,
  withoutInstallIntent,
} from "./skill-install-intent";

const search = (value: string) => new URLSearchParams(value);

test("only install=1 is an install request", () => {
  expect(hasInstallIntent(search("install=1"))).toBe(true);
  expect(hasInstallIntent(search("tab=skill&install=1"))).toBe(true);
  expect(hasInstallIntent(search(""))).toBe(false);
  expect(hasInstallIntent(search("install=0"))).toBe(false);
  expect(hasInstallIntent(search("install=true"))).toBe(false);
});

test("stripping removes only the install param and keeps the hash", () => {
  expect(withoutInstallIntent("/dashboard/skills/x", search("install=1"))).toBe(
    "/dashboard/skills/x",
  );
  expect(
    withoutInstallIntent(
      "/dashboard/skills/x",
      search("a=1&install=1&b=two%20words"),
      "#versions",
    ),
  ).toBe("/dashboard/skills/x?a=1&b=two+words#versions");
});

test("stripping does not touch the params it was given", () => {
  const params = search("install=1&a=1");
  withoutInstallIntent("/p", params);
  expect(params.get("install")).toBe("1");
});

test("a link never installs: an installable, not yet installed skill is asked about", () => {
  expect(
    resolveInstallIntent({
      requested: true,
      loading: false,
      skill: { enabled: false, installable: true },
    }),
  ).toBe("prompt");
  // `installable` absent means installable, as the page's own button reads it.
  expect(
    resolveInstallIntent({
      requested: true,
      loading: false,
      skill: { enabled: false },
    }),
  ).toBe("prompt");
});

test("already installed or not installable: the param just goes away", () => {
  expect(
    resolveInstallIntent({
      requested: true,
      loading: false,
      skill: { enabled: true, installable: true },
    }),
  ).toBe("strip");
  expect(
    resolveInstallIntent({
      requested: true,
      loading: false,
      skill: { enabled: false, installable: false },
    }),
  ).toBe("strip");
});

test("while loading, or when the skill is not there, the URL is left alone", () => {
  expect(
    resolveInstallIntent({ requested: true, loading: true, skill: null }),
  ).toBe("wait");
  expect(
    resolveInstallIntent({
      requested: true,
      loading: true,
      skill: { enabled: false },
    }),
  ).toBe("wait");
  expect(
    resolveInstallIntent({ requested: true, loading: false, skill: null }),
  ).toBe("wait");
});

test("once the param is gone nothing is asked again", () => {
  expect(
    resolveInstallIntent({
      requested: false,
      loading: false,
      skill: { enabled: false, installable: true },
    }),
  ).toBe("none");
});
