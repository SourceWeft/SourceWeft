import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "vitest";
import type { SkillManifestJson } from "@sourceweft/db";
import {
  __clearPointerBundleCache,
  loadPointerSkillBundle,
  parsePointer,
} from "./pointer-bundle";

type RegistryManifest = NonNullable<SkillManifestJson["registry"]>;

const SHA = "a".repeat(40);

function sha256(value: string) {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function manifestEntry(
  path: string,
  contentText: string,
  overrides: Partial<RegistryManifest["fileManifest"][number]> = {},
): RegistryManifest["fileManifest"][number] {
  return {
    path,
    sha256: sha256(contentText),
    sizeBytes: Buffer.byteLength(contentText, "utf8"),
    role: "model-readable",
    ...overrides,
  };
}

function registry(
  fileManifest: RegistryManifest["fileManifest"],
): RegistryManifest {
  return {
    identifier: "gh:acme/skill",
    sourceUrl: "https://github.com/acme/skill",
    repoUrl: "https://github.com/acme/skill",
    submittedBy: "user-1",
    capability: "prompt-only",
    scan: { reviewRequired: false, flags: [] },
    licenseTier: "permissive",
    fileManifest,
  };
}

/**
 * Mock fetch that serves file bodies keyed by their raw path suffix, counting
 * calls. Any path not in `bodies` yields a 404.
 */
function mockFetch(bodies: Record<string, string>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const href = typeof url === "string" ? url : url.toString();
    calls.push(href);
    const match = Object.keys(bodies).find((path) =>
      href.endsWith(`/${path}`),
    );
    if (!match) {
      return new Response("not found", { status: 404 });
    }
    return new Response(bodies[match], { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  __clearPointerBundleCache();
});

test("parsePointer parses github:<owner>/<repo>@<sha>#<path>", () => {
  const parsed = parsePointer(`github:acme/skill@${SHA}#skills/writer`);
  assert.deepEqual(parsed, {
    owner: "acme",
    repo: "skill",
    sha: SHA,
    subpath: "skills/writer",
  });
});

test("parsePointer accepts a root-level skill (no subpath)", () => {
  assert.deepEqual(parsePointer(`github:acme/skill@${SHA}`), {
    owner: "acme",
    repo: "skill",
    sha: SHA,
    subpath: "",
  });
});

test("parsePointer rejects non-pointer, abbreviated sha, and traversal", () => {
  assert.equal(parsePointer("db://version-1"), null);
  assert.equal(parsePointer("acme/skill@abc123"), null);
  assert.equal(parsePointer(`github:acme/skill@${"a".repeat(7)}`), null);
  assert.equal(parsePointer(`github:acme/skill@${SHA}#../escape`), null);
});

test("fetches, verifies, and returns model-readable files (scripts skipped)", async () => {
  const skillMd = "# Writer\ninstructions";
  const resource = "extra notes";
  const contentHash = sha256(skillMd);
  const { fetchImpl, calls } = mockFetch({
    "skills/writer/SKILL.md": skillMd,
    "skills/writer/resources/notes.md": resource,
    // A script body exists on the remote but must never be fetched here.
    "skills/writer/scripts/run.py": "print('nope')",
  });

  const files = await loadPointerSkillBundle(
    `github:acme/skill@${SHA}#skills/writer`,
    contentHash,
    registry([
      manifestEntry("SKILL.md", skillMd),
      manifestEntry("resources/notes.md", resource),
      manifestEntry("scripts/run.py", "print('nope')", { role: "script" }),
    ]),
    { fetchImpl },
  );

  assert.ok(files);
  assert.equal(files.length, 2);
  const skill = files.find((f) => f.path === "SKILL.md");
  assert.ok(skill);
  assert.equal(skill.contentText, skillMd);
  assert.equal(skill.mimeType, "text/markdown");
  assert.equal(skill.contentHash, contentHash);
  // Script role is not fetched at runtime (§6b execution sandbox).
  assert.equal(
    calls.some((href) => href.endsWith("/scripts/run.py")),
    false,
  );
});

test("rejects the skill when a fetched file fails its manifest sha256", async () => {
  const skillMd = "# Writer";
  const { fetchImpl } = mockFetch({ "SKILL.md": "tampered body" });
  const files = await loadPointerSkillBundle(
    `github:acme/skill@${SHA}`,
    sha256(skillMd),
    // Manifest advertises the honest hash; the served body differs → tamper.
    registry([manifestEntry("SKILL.md", skillMd)]),
    { fetchImpl },
  );
  assert.equal(files, null);
});

test("rejects when the fetched SKILL.md hash disagrees with contentHash", async () => {
  const skillMd = "# Writer";
  const { fetchImpl } = mockFetch({ "SKILL.md": skillMd });
  const files = await loadPointerSkillBundle(
    `github:acme/skill@${SHA}`,
    // Version contentHash does not match the (valid, self-consistent) file.
    sha256("a different skill.md"),
    registry([manifestEntry("SKILL.md", skillMd)]),
    { fetchImpl },
  );
  assert.equal(files, null);
});

test("returns null (skip) on a fetch failure instead of throwing", async () => {
  const skillMd = "# Writer";
  // No bodies registered → mock returns 404 for every request.
  const { fetchImpl } = mockFetch({});
  const files = await loadPointerSkillBundle(
    `github:acme/skill@${SHA}`,
    sha256(skillMd),
    registry([manifestEntry("SKILL.md", skillMd)]),
    { fetchImpl },
  );
  assert.equal(files, null);
});

test("returns null for an invalid pointer or a missing registry manifest", async () => {
  const { fetchImpl, calls } = mockFetch({ "SKILL.md": "# x" });
  assert.equal(
    await loadPointerSkillBundle("db://version-1", sha256("# x"), registry([]), {
      fetchImpl,
    }),
    null,
  );
  assert.equal(
    await loadPointerSkillBundle(`github:acme/skill@${SHA}`, "hash", undefined, {
      fetchImpl,
    }),
    null,
  );
  // No network was touched for either rejection.
  assert.equal(calls.length, 0);
});

test("second resolve of the same pointer hits the in-process LRU (no refetch)", async () => {
  const skillMd = "# Writer";
  const contentHash = sha256(skillMd);
  const { fetchImpl, calls } = mockFetch({ "SKILL.md": skillMd });
  const pointer = `github:acme/skill@${SHA}`;
  const manifest = registry([manifestEntry("SKILL.md", skillMd)]);

  const first = await loadPointerSkillBundle(pointer, contentHash, manifest, {
    fetchImpl,
  });
  assert.ok(first);
  const callsAfterFirst = calls.length;
  assert.equal(callsAfterFirst, 1);

  const second = await loadPointerSkillBundle(pointer, contentHash, manifest, {
    fetchImpl,
  });
  assert.deepEqual(second, first);
  // Cache hit → no additional fetch.
  assert.equal(calls.length, callsAfterFirst);
});
