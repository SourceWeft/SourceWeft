import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { resolveCapabilityRecordToolIds } from "./index";

const HOST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Guards the two ways a tool reaches a turn's tool set, the boundary a
 * skill-shipped tool (ppt-deck's `review_deck_visuals`) once fell through:
 * bound because permissions enabled it, yet never created because the binder
 * only read top-level `contributes.tools` and a skill cannot declare those.
 */

type Contributions = Parameters<typeof resolveCapabilityRecordToolIds>[0];

function contributions(input: {
  tools?: readonly string[];
  skillRuntimeTools?: readonly (readonly string[])[];
}): Contributions {
  return {
    connectors: [],
    documentParsers: [],
    retrieval: [],
    vfs: [],
    tools: (input.tools ?? []).map((id) => ({ id })),
    skills: (input.skillRuntimeTools ?? []).map((tools) => ({
      runtime: { tools: [...tools] },
    })),
  } as unknown as Contributions;
}

const bindAll = () => true;
const bindNone = () => false;

test("top-level tool contributions bind regardless of shouldBind", () => {
  // A kind:"tool" package's own tools are always offered to its factory; the
  // factory, not the binder, decides per turn whether to keep them.
  const ids = resolveCapabilityRecordToolIds(
    contributions({ tools: ["execute", "prepare_sandbox_workspace"] }),
    bindNone,
  );
  assert.deepEqual([...ids].sort(), ["execute", "prepare_sandbox_workspace"]);
});

test("skill runtime tools bind only when the turn selected them", () => {
  const selected = resolveCapabilityRecordToolIds(
    contributions({ skillRuntimeTools: [["review_deck_visuals"]] }),
    bindAll,
  );
  assert.deepEqual(selected, ["review_deck_visuals"]);

  const notSelected = resolveCapabilityRecordToolIds(
    contributions({ skillRuntimeTools: [["review_deck_visuals"]] }),
    bindNone,
  );
  assert.deepEqual(notSelected, []);
});

test("a skill that ships its own tool reaches its factory (review_deck_visuals regression)", () => {
  // ppt-deck's manifest: no top-level tools, review_deck_visuals only in the
  // skill runtime contract. Pre-fix this returned [] and the factory was
  // skipped, so visual QA could never bind.
  const ids = resolveCapabilityRecordToolIds(
    contributions({
      tools: [],
      skillRuntimeTools: [
        [
          "prepare_sandbox_workspace",
          "execute",
          "generate_image",
          "review_deck_visuals",
          "publish_artifact",
        ],
      ],
    }),
    // Only review_deck_visuals is off-by-default + skill-activated here; the
    // rest come from their own kind:"tool" packages and are gated elsewhere.
    (id) => id === "review_deck_visuals",
  );
  assert.ok(
    ids.includes("review_deck_visuals"),
    "review_deck_visuals must be offered to ppt-deck's factory so the tool binds",
  );
});

test("ids are de-duplicated across top-level and skill runtime sources", () => {
  const ids = resolveCapabilityRecordToolIds(
    contributions({
      tools: ["generate_image"],
      skillRuntimeTools: [["generate_image", "review_deck_visuals"]],
    }),
    bindAll,
  );
  assert.deepEqual([...ids].sort(), ["generate_image", "review_deck_visuals"]);
});

// ── Manifest-level invariant ────────────────────────────────────────────────

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 20; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("repo root (pnpm-workspace.yaml) not found from test dir");
}

type Manifest = {
  kind?: string;
  entry?: string;
  tools?: ReadonlyArray<{ id: string }>;
  skills?: ReadonlyArray<{ runtime?: { tools?: readonly string[] } }>;
};

test("every builtin skill runtime tool id has a binding path", () => {
  const packagesDir = join(findRepoRoot(HOST_DIR), "packages");
  const packageNames = readdirSync(packagesDir).filter((name) =>
    existsSync(join(packagesDir, name, "sourceweft.capability.json")),
  );

  const records = packageNames.map((name) => {
    const dir = join(packagesDir, name);
    const manifest = JSON.parse(
      readFileSync(join(dir, "sourceweft.capability.json"), "utf8"),
    ) as Manifest;
    const entryFile = join(dir, manifest.entry ?? "./src/index.ts");
    const entrySource = existsSync(entryFile)
      ? readFileSync(entryFile, "utf8")
      : "";
    return {
      name,
      manifest,
      // A package ships tools of its own when its entry module exports the
      // capability-tools factory; that factory is how a skill-declared tool
      // becomes a real, callable tool.
      shipsOwnFactory: /createCapabilityAgentTools\b/.test(entrySource),
    };
  });

  // The tools bindable through the always-on, top-level path: any package's
  // `contributes.tools`.
  const topLevelToolIds = new Set<string>(
    records.flatMap((record) =>
      (record.manifest.tools ?? []).map((tool) => tool.id),
    ),
  );

  const violations: string[] = [];
  for (const record of records) {
    const skillRuntimeToolIds = (record.manifest.skills ?? []).flatMap(
      (skill) => skill.runtime?.tools ?? [],
    );
    for (const toolId of skillRuntimeToolIds) {
      const boundByToolPackage = topLevelToolIds.has(toolId);
      const boundBySameSkillPackage = record.shipsOwnFactory;
      if (!boundByToolPackage && !boundBySameSkillPackage) {
        violations.push(
          `${record.name}: skill runtime tool "${toolId}" has no binding path — ` +
            `it is not a top-level tool of any package and ${record.name} does not export createCapabilityAgentTools`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Unbindable skill runtime tools found:\n${violations.join("\n")}`,
  );
});
