import sharp from "sharp";
import { expect, test } from "vitest";
import { extractRegistryLogo, MAX_LOGO_BYTES } from "./logo";
import { discoveredSkillFile, type DiscoveredSkill } from "./read";
import { getSkillLogo } from "../logo";
import type { SkillManifestJson } from "@sourceweft/db";

function bundle(
  extra = "",
  files: Record<string, string> = {},
): DiscoveredSkill {
  return {
    repoSubpath: "skills/writer",
    dirName: "writer",
    files: Object.entries({
      "SKILL.md": `---\nname: writer\ndescription: Writes reports\n${extra}---\nInstructions`,
      ...files,
    }).map(([bundlePath, contentText]) =>
      discoveredSkillFile(bundlePath, Buffer.from(contentText)),
    ),
  };
}
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="red"/></svg>';

test("imports declared binary icons as small persisted PNGs without changing runtime files", async () => {
  const skill = bundle("icon: ./assets/writer.png\n");
  skill.files.push(
    discoveredSkillFile(
      "assets/writer.png",
      await sharp({
        create: { width: 300, height: 180, channels: 4, background: "red" },
      })
        .png()
        .toBuffer(),
    ),
  );
  const before = JSON.stringify(skill.files);
  const result = await extractRegistryLogo(skill);
  expect(result.diagnostics).toEqual([]);
  expect(result.logo).toMatchObject({
    source: "skill",
    path: "assets/writer.png",
  });
  const metadata = await sharp(
    Buffer.from(result.logo!.url.split(",")[1]!, "base64"),
  ).metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBe(128);
  expect(JSON.stringify(skill.files)).toBe(before);
});
test("uses agent interface branding ahead of conventionally named files", async () => {
  const result = await extractRegistryLogo(
    bundle("", {
      "agents/openai.yaml":
        "interface:\n  icon_small: ./assets/small.svg\n  icon_large: ./assets/large.svg",
      "assets/large.svg": svg,
      "logo.svg": svg,
    }),
  );
  expect(result.logo?.path).toBe("assets/large.svg");
});
test("discovers root or assets logos deterministically and ignores illustrations", async () => {
  expect(
    (
      await extractRegistryLogo(
        bundle("", { "assets/icon.svg": svg, "logo.svg": svg }),
      )
    ).logo?.path,
  ).toBe("logo.svg");
  expect(
    (await extractRegistryLogo(bundle("", { "assets/logo.svg": svg }))).logo
      ?.path,
  ).toBe("assets/logo.svg");
  expect(
    (
      await extractRegistryLogo(
        bundle("", {
          "assets/chart.svg": svg,
          "references/other/logo.svg": svg,
        }),
      )
    ).logo,
  ).toBeUndefined();
});
test("preserves HTTPS declarations and diagnoses invalid URLs, traversal and missing files", async () => {
  expect(
    (await extractRegistryLogo(bundle("logo: https://example.com/logo.png\n")))
      .logo?.url,
  ).toBe("https://example.com/logo.png");
  for (const declaration of [
    "../other/logo.svg",
    "/tmp/logo.png",
    "javascript:alert(1)",
    "http://example.com/logo.png",
    "missing.png",
    "https://user:secret@example.com/logo.png",
  ]) {
    const result = await extractRegistryLogo(bundle(`logo: ${declaration}\n`));
    expect(result.logo).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("SKILL_LOGO_UNAVAILABLE");
  }
});
test("external SVG resources, disguised SVGs, corrupt and oversized images are diagnosed", async () => {
  for (const bytes of [
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',
    ),
    Buffer.from("not an image"),
    Buffer.alloc(MAX_LOGO_BYTES + 1),
  ]) {
    const skill = bundle("logo: logo.png\n");
    skill.files.push(discoveredSkillFile("logo.png", bytes));
    const result = await extractRegistryLogo(skill);
    expect(result.logo).toBeUndefined();
    expect(result.diagnostics[0]?.severity).toBe("warning");
  }
});
test("a self-contained SVG may use internal gradient references", async () => {
  const result = await extractRegistryLogo(
    bundle("", {
      "logo.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="48" height="48" fill="url(\'#g\')"/></svg>',
    }),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.logo?.url).toMatch(/^data:image\/png;base64,/);
});
test("legacy imports derive publisher avatars without altering frozen metadata", () => {
  const manifest = {
    registry: { repoUrl: "https://github.com/anthropics/skills" },
  } as SkillManifestJson;
  const before = JSON.stringify(manifest);
  expect(getSkillLogo(manifest)).toEqual({
    url: "https://github.com/anthropics.png?size=128",
    source: "publisher",
  });
  expect(JSON.stringify(manifest)).toBe(before);
  expect(
    getSkillLogo({
      ...manifest,
      logo: { url: "https://example.com/logo.png", source: "skill" },
    })?.source,
  ).toBe("skill");
  expect(
    getSkillLogo({
      registry: { repoUrl: "https://github.com.evil.example/owner/repo" },
    } as SkillManifestJson),
  ).toBeUndefined();
  expect(getSkillLogo({} as SkillManifestJson)).toBeUndefined();
});
