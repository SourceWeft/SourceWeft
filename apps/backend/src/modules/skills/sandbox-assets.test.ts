import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test, vi } from "vitest";
import { unzipSync } from "fflate";

// Object storage is an in-memory map here: what matters is WHICH calls a plan
// makes (presign and whole-bundle reads, on demand) — never real storage.
const store = vi.hoisted(() => ({
  bundles: new Map<string, Uint8Array>(),
  presigned: [] as string[],
  bundleReads: [] as string[],
  zipped: 0,
}));

vi.mock("./storage", async (original) => {
  const actual = await original<typeof import("./storage")>();
  return {
    ...actual,
    buildSkillBundleZip: (
      ...args: Parameters<typeof actual.buildSkillBundleZip>
    ) => {
      store.zipped += 1;
      return actual.buildSkillBundleZip(...args);
    },
    presignSkillBundleUrl: async (objectKey: string) => {
      store.presigned.push(objectKey);
      return `https://storage.test/${objectKey}?signed`;
    },
    readSkillBundle: async (objectKey: string) => {
      store.bundleReads.push(objectKey);
      return store.bundles.get(objectKey)!;
    },
  };
});

const {
  buildSkillSandboxAssetPlan,
  buildSkillSandboxAssetPlans,
  skillStagingRejection,
  TurnSkillSandboxAssets,
} = await import("./sandbox-assets");
const { SKILL_STORAGE_LIMITS } = await import("./storage");
const { inlineSkillContent } = await import("./file-content");
const { ContentError } = await import("../content/errors");
type EnabledSkillDescriptor = import("./types").EnabledSkillDescriptor;
type SkillFileManifestEntry = import("./types").SkillFileManifestEntry;

beforeEach(() => {
  store.bundles.clear();
  store.presigned = [];
  store.bundleReads = [];
  store.zipped = 0;
});

function bundleFile(path: string, contentText: string) {
  return {
    path,
    contentText,
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(contentText, "utf8"),
    contentHash: createHash("sha256").update(contentText).digest("hex"),
  };
}

/** An in-process skill (`db_text` / `repo_builtin`): no stored bundle. */
function skill(
  overrides: Partial<EnabledSkillDescriptor> & {
    texts?: ReturnType<typeof bundleFile>[];
  } = {},
): EnabledSkillDescriptor {
  const { texts, ...rest } = overrides;
  return {
    workspaceSkillId: "ws-skill-1",
    sourceType: "workspace_custom",
    name: "ppt-deck",
    version: "1.2.0",
    description: "Deck builder",
    ...inlineSkillContent(
      texts ?? [
        bundleFile("SKILL.md", "# ppt-deck"),
        bundleFile("scripts/validate_pptx.py", "print('ok')"),
      ],
    ),
    ...rest,
  };
}

function manifestEntry(
  path: string,
  sizeBytes: number,
  isText = true,
): SkillFileManifestEntry {
  return {
    path,
    mimeType: isText ? "text/markdown" : "font/ttf",
    sizeBytes,
    contentHash: `hash-${path}`,
    isText,
  };
}

/** A community skill (`object`): a manifest and a stored bundle, no bodies. */
function objectSkill(
  overrides: Partial<EnabledSkillDescriptor> = {},
): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "ws-skill-object",
    sourceType: "registry_github",
    name: "gh-brand",
    version: "abc123def456",
    description: "Brand kit",
    files: [
      manifestEntry("SKILL.md", 40),
      manifestEntry("assets/brand.ttf", 4 * 1024 * 1024, false),
    ],
    skillMd: "# brand",
    readFile: async () => {
      throw new Error("an object skill's bodies must not be read to plan it");
    },
    bundle: {
      sha256: "c".repeat(64),
      objectKey: `skills/bundles/${"c".repeat(64)}.zip`,
      sizeBytes: 3 * 1024 * 1024,
    },
    ...overrides,
  };
}

test("an in-process skill gets a deterministic zip targeting the /skills contract path", async () => {
  const plan = await buildSkillSandboxAssetPlan(skill());
  assert.equal(plan.name, "ppt-deck");
  assert.equal(plan.version, "1.2.0");
  assert.equal(plan.installDir, "/skills/ppt-deck");
  assert.equal(plan.entrypoint, "SKILL.md");
  assert.equal(plan.archive, "zip");
  assert.match(plan.sha256, /^[a-f0-9]{64}$/u);
  // No stored bundle → nothing to presign; the bytes are uploaded.
  assert.equal(plan.fetchUrl, undefined);

  // Same content → same digest, and the cached zip is reused.
  const zippedOnce = store.zipped;
  const again = await buildSkillSandboxAssetPlan(skill());
  assert.equal(again.sha256, plan.sha256);
  assert.equal(store.zipped, zippedOnce);

  // Different content → different digest.
  const changed = await buildSkillSandboxAssetPlan(
    skill({
      texts: [
        bundleFile("SKILL.md", "# ppt-deck v2"),
        bundleFile("scripts/validate_pptx.py", "print('ok')"),
      ],
    }),
  );
  assert.notEqual(changed.sha256, plan.sha256);
});

test("loadContent returns a zip whose bytes hash to the plan sha", async () => {
  const plan = await buildSkillSandboxAssetPlan(
    skill({ texts: [bundleFile("SKILL.md", "# zip me"), bundleFile("a/b.md", "b")] }),
  );
  const content = await plan.loadContent!();
  assert.ok(content && content.byteLength > 0);
  assert.equal(createHash("sha256").update(content).digest("hex"), plan.sha256);
  assert.deepEqual(Object.keys(unzipSync(content)).sort(), [
    "SKILL.md",
    "a/b.md",
  ]);
  assert.equal(
    new TextDecoder().decode(unzipSync(content)["SKILL.md"]),
    "# zip me",
  );
});

test("an object skill's plan is the stored bundle: its sha, a presigned URL, a whole-bundle fallback — never a zip", async () => {
  const descriptor = objectSkill();
  store.bundles.set(descriptor.bundle!.objectKey, new Uint8Array([9, 9, 9]));

  const plan = await buildSkillSandboxAssetPlan(descriptor);

  assert.equal(plan.sha256, descriptor.bundle!.sha256);
  assert.equal(plan.installDir, "/skills/gh-brand");
  // Planning touches nothing: no zip, no presign, no download, no body.
  assert.equal(store.zipped, 0);
  assert.deepEqual(store.presigned, []);
  assert.deepEqual(store.bundleReads, []);

  assert.equal(
    await plan.fetchUrl!(),
    `https://storage.test/${descriptor.bundle!.objectKey}?signed`,
  );
  assert.deepEqual(await plan.loadContent!(), new Uint8Array([9, 9, 9]));
  assert.deepEqual(store.bundleReads, [descriptor.bundle!.objectKey]);
  assert.equal(store.zipped, 0);
});

test("normalizes unsafe version strings without losing content authority", async () => {
  const plan = await buildSkillSandboxAssetPlan(skill({ version: "2.0 β/beta" }));
  assert.match(plan.version, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
});

test("a skill that cannot be staged is rejected from its manifest, under the storage limits", async () => {
  const tooMany = Array.from(
    { length: SKILL_STORAGE_LIMITS.maxFiles + 1 },
    (_, index) => manifestEntry(index === 0 ? "SKILL.md" : `f/${index}.md`, 1),
  );
  for (const [invalidSkill, expectedReason] of [
    [skill({ name: "../evil" }), "unsafe_name"],
    [
      skill({ name: "no-skill-md", texts: [bundleFile("README.md", "no entry")] }),
      "missing_skill_md",
    ],
    [
      skill({
        name: "traversal",
        texts: [bundleFile("SKILL.md", "# x"), bundleFile("../outside.txt", "e")],
      }),
      "unsafe_file_path",
    ],
    [skill({ name: "many", files: tooMany }), "too_many_files"],
    [
      skill({
        name: "big-file",
        files: [
          manifestEntry("SKILL.md", 1),
          manifestEntry("blob.txt", SKILL_STORAGE_LIMITS.maxFileBytes + 1),
        ],
      }),
      "file_too_large",
    ],
    [
      skill({
        name: "too-big",
        files: [
          manifestEntry("SKILL.md", 1),
          ...Array.from({ length: 6 }, (_, index) =>
            manifestEntry(`blob-${index}.txt`, SKILL_STORAGE_LIMITS.maxFileBytes),
          ),
        ],
      }),
      "bundle_too_large",
    ],
    [
      objectSkill({
        bundle: {
          sha256: "c".repeat(64),
          objectKey: "k",
          sizeBytes: SKILL_STORAGE_LIMITS.maxBundleBytes + 1,
        },
      }),
      "bundle_too_large",
    ],
    [skill({ name: "empty-bundle", files: [] }), "empty_bundle"],
  ] as const) {
    assert.equal(skillStagingRejection(invalidSkill)?.reason, expectedReason);
    await assert.rejects(
      buildSkillSandboxAssetPlans([invalidSkill]),
      (error) =>
        error instanceof ContentError &&
        error.code === "SKILL_SANDBOX_ASSET_INVALID" &&
        (error.details as { reason?: string }).reason === expectedReason,
    );
  }

  // What the old 2 MB / per-skill cap refused now stages.
  assert.equal(
    skillStagingRejection(
      skill({
        files: [manifestEntry("SKILL.md", 1), manifestEntry("d.csv", 5 * 1024 * 1024)],
      }),
    ),
    null,
  );
});

test("the turn registry grows, returns the current set, and replaces a re-registered name", async () => {
  const registry = new TurnSkillSandboxAssets();
  assert.equal(registry.hasPlans(), false);
  assert.deepEqual(await registry.plans(), []);

  assert.deepEqual(registry.add([skill()]), { rejected: [] });
  assert.deepEqual(
    (await registry.plans()).map((plan) => plan.name),
    ["ppt-deck"],
  );

  // A skill installed mid-turn joins the set the sandbox manager reads next.
  registry.add([skill({ name: "notes", workspaceSkillId: "ws-skill-2" })]);
  assert.equal(registry.hasPlans(), true);
  assert.deepEqual(
    (await registry.plans()).map((plan) => plan.name),
    ["ppt-deck", "notes"],
  );

  // Re-registering a name replaces its plan: /skills/<name>/ is one path.
  const before = (await registry.plans())[0]!.sha256;
  registry.add([skill({ texts: [bundleFile("SKILL.md", "# ppt-deck, edited")] })]);
  const after = await registry.plans();
  assert.deepEqual(
    after.map((plan) => plan.name),
    ["ppt-deck", "notes"],
  );
  assert.notEqual(after[0]!.sha256, before);
});

test("an unstageable skill degrades alone: add() never throws and every other skill still plans", async () => {
  const registry = new TurnSkillSandboxAssets();
  const tooBig = objectSkill({
    name: "gh-huge",
    bundle: {
      sha256: "d".repeat(64),
      objectKey: "huge",
      sizeBytes: SKILL_STORAGE_LIMITS.maxBundleBytes + 1,
    },
  });
  const malformed = skill({
    name: "no-skill-md",
    texts: [bundleFile("README.md", "no entry")],
  });

  const { rejected } = registry.add([skill(), tooBig, objectSkill(), malformed]);

  assert.deepEqual(
    rejected.map((rejection) => [rejection.name, rejection.reason]),
    [
      ["gh-huge", "bundle_too_large"],
      ["no-skill-md", "missing_skill_md"],
    ],
  );
  assert.deepEqual(
    (await registry.plans()).map((plan) => plan.name),
    ["ppt-deck", "gh-brand"],
  );
  // What the sandbox manager records as failed, so `/skills/gh-huge/...` gets
  // SANDBOX_SKILL_STAGING_UNAVAILABLE instead of "No such file".
  assert.deepEqual(registry.unstageable(), [
    {
      name: "gh-huge",
      version: "abc123def456",
      error: "not stageable: bundle_too_large",
    },
    {
      name: "no-skill-md",
      version: "1.2.0",
      error: "not stageable: missing_skill_md",
    },
  ]);

  // Only unstageable skills: /skills commands must still be deferred to the
  // staging check (not denied outright) so they get the recoverable error.
  const onlyBad = new TurnSkillSandboxAssets();
  onlyBad.add([malformed]);
  assert.equal(onlyBad.hasPlans(), true);
  assert.deepEqual(await onlyBad.plans(), []);

  // A fixed re-install clears the verdict.
  registry.add([
    skill({ name: "no-skill-md", texts: [bundleFile("SKILL.md", "# fixed")] }),
  ]);
  assert.deepEqual(
    registry.unstageable().map((entry) => entry.name),
    ["gh-huge"],
  );
});

test("an in-process bundle whose bodies will not load moves to unstageable instead of failing plans()", async () => {
  const registry = new TurnSkillSandboxAssets();
  registry.add([
    skill(),
    skill({
      name: "flaky",
      texts: [bundleFile("SKILL.md", "# never zipped before, so not cached")],
      readFile: async () => {
        throw new Error("database is down");
      },
    }),
  ]);

  assert.deepEqual(
    (await registry.plans()).map((plan) => plan.name),
    ["ppt-deck"],
  );
  assert.deepEqual(registry.unstageable(), [
    {
      name: "flaky",
      version: "1.2.0",
      error: "not stageable: bundle_build_failed",
    },
  ]);
});
