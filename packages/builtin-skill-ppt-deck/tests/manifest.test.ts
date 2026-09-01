import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "@sourceweft/capability-runtime";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json parses as a valid ppt-deck skill manifest", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );
  const manifest = capabilityManifestSchema.parse(JSON.parse(rawManifest));
  const skill = getCapabilityContributions(manifest).skills[0];

  assert.equal(manifest.id, "sourceweft/ppt-deck");
  assert.equal(skill?.id, "ppt-deck");
  assert.equal(skill?.visibility, "restricted");
  assert.equal(skill?.defaultEnabled, true);
  assert.deepEqual(skill?.options?.[0]?.target, {
    path: "config.stylePreset",
  });
});

test("every stylePreset value maps to a documented theme preset", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );
  const manifest = capabilityManifestSchema.parse(JSON.parse(rawManifest));
  const skill = getCapabilityContributions(manifest).skills[0];
  const stylePreset = skill?.options?.find(
    (option) => option.id === "stylePreset",
  );
  assert.ok(stylePreset, "ppt-deck manifest no longer declares stylePreset");

  const skillMd = await readFile(join(packageRoot, "SKILL.md"), "utf8");
  const designSystem = await readFile(
    join(packageRoot, "references", "design-system.md"),
    "utf8",
  );

  for (const { value } of stylePreset.values ?? []) {
    const row = skillMd
      .split("\n")
      .find((line) => line.startsWith(`| ${String(value)} | `));
    assert.ok(
      row,
      `stylePreset "${String(value)}" has no mapping row in SKILL.md`,
    );
    if (value === "auto") continue;
    const themePreset = row.split("|")[2]?.trim();
    assert.ok(
      themePreset && designSystem.includes(`### ${themePreset}`),
      `SKILL.md maps stylePreset "${String(value)}" to "${themePreset}", which has no preset section in design-system.md`,
    );
  }
});
