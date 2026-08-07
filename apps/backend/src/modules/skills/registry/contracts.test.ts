import assert from "node:assert/strict";
import { test } from "vitest";
import {
  deriveRegistrySlug,
  resolveLicenseTier,
  submitRegistrySkillRequestSchema,
  submitRegistrySkillResponseSchema,
} from "./contracts";

test("submit request accepts a trimmed repoUrl and rejects empty", () => {
  const parsed = submitRegistrySkillRequestSchema.parse({
    repoUrl: "  https://github.com/acme/skill  ",
  });
  // Shorthand and full URLs both pass through — normalization is server-side.
  assert.equal(parsed.repoUrl, "https://github.com/acme/skill");
  assert.ok(submitRegistrySkillRequestSchema.safeParse({ repoUrl: "acme/skill" }).success);

  assert.equal(submitRegistrySkillRequestSchema.safeParse({ repoUrl: "" }).success, false);
  assert.equal(submitRegistrySkillRequestSchema.safeParse({ repoUrl: "   " }).success, false);
  assert.equal(submitRegistrySkillRequestSchema.safeParse({}).success, false);
});

test("submit response constrains status and keeps slug optional", () => {
  assert.ok(submitRegistrySkillResponseSchema.safeParse({ status: "indexed", slug: "gh-a-b" }).success);
  assert.ok(submitRegistrySkillResponseSchema.safeParse({ status: "queued" }).success);
  assert.equal(submitRegistrySkillResponseSchema.safeParse({ status: "active" }).success, false);
});

test("licenseTier: permissive family (MIT/Apache/BSD/ISC/CC-BY)", () => {
  for (const license of [
    "MIT",
    "MIT-0",
    "Apache-2.0",
    "BSD-3-Clause",
    "0BSD",
    "ISC",
    "CC-BY-4.0",
    "Creative Commons Attribution 4.0",
  ]) {
    assert.equal(resolveLicenseTier(license), "permissive", license);
  }
});

test("licenseTier: copyleft family (GPL/LGPL/MPL/CC-BY-SA)", () => {
  for (const license of [
    "GPL-3.0",
    "GPLv3",
    "GNU General Public License v3.0",
    "LGPL-2.1",
    "MPL-2.0",
    "Mozilla Public License 2.0",
    "CC-BY-SA-4.0",
  ]) {
    assert.equal(resolveLicenseTier(license), "copyleft", license);
  }
});

test("licenseTier: AGPL is grouped with unknown, not copyleft", () => {
  // The redistribution-sensitive case: AGPL contains 'GPL' but must NOT be
  // read as copyleft (§5.5) — its network-use trigger keeps it non-surfacing.
  assert.equal(resolveLicenseTier("AGPL-3.0"), "unknown");
  assert.equal(resolveLicenseTier("GNU Affero General Public License v3.0"), "unknown");
});

test("licenseTier: no license / unrecognized fall closed to unknown", () => {
  assert.equal(resolveLicenseTier(undefined), "unknown");
  assert.equal(resolveLicenseTier(null), "unknown");
  assert.equal(resolveLicenseTier(""), "unknown");
  assert.equal(resolveLicenseTier("   "), "unknown");
  assert.equal(resolveLicenseTier("Proprietary"), "unknown");
  assert.equal(resolveLicenseTier("The Unlicense"), "unknown");
  assert.equal(resolveLicenseTier("WTFPL"), "unknown");
});

test("slug: base form is sanitized to [a-z0-9-] and deterministic", () => {
  const slug = deriveRegistrySlug("My.Org", "Cool_Repo!");
  assert.equal(slug, "gh-my-org-cool-repo");
  assert.match(slug, /^[a-z0-9-]+$/u);
  // Deterministic — same inputs, same slug.
  assert.equal(deriveRegistrySlug("My.Org", "Cool_Repo!"), slug);
  // Empty/whitespace/undefined subpath is treated as "no subpath" (no suffix).
  assert.equal(deriveRegistrySlug("acme", "skill"), "gh-acme-skill");
  assert.equal(deriveRegistrySlug("acme", "skill", ""), "gh-acme-skill");
  assert.equal(deriveRegistrySlug("acme", "skill", "  "), "gh-acme-skill");
  assert.equal(deriveRegistrySlug("acme", "skill", "/"), "gh-acme-skill");
});

test("slug: distinct subpaths in one repo never collide", () => {
  const a = deriveRegistrySlug("acme", "skills", "skills/a");
  const b = deriveRegistrySlug("acme", "skills", "skills/b");
  assert.notEqual(a, b);
  assert.match(a, /^gh-acme-skills-[a-f0-9]{8}$/u);
  assert.match(b, /^gh-acme-skills-[a-f0-9]{8}$/u);

  // Same subpath → same 8-hex suffix (deterministic pin key).
  assert.equal(a, deriveRegistrySlug("acme", "skills", "skills/a"));

  // Leading/trailing slashes are normalized away — same logical subpath.
  assert.equal(a, deriveRegistrySlug("acme", "skills", "/skills/a/"));

  // Paths that would SANITIZE to the same string ("skills/a" vs "skills-a")
  // must still differ, because the hash is over the raw (not sanitized) path.
  assert.notEqual(
    deriveRegistrySlug("acme", "skills", "skills/a"),
    deriveRegistrySlug("acme", "skills", "skills-a"),
  );
});
