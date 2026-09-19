import { describe, expect, test } from "vitest";
import type { SkillManifestJson } from "@sourceweft/db";
import { describeVersionEscalation } from "./versions";

function manifest(
  capability: "prompt-only" | "executable" | null,
  flags: string[] = [],
): SkillManifestJson {
  return {
    slug: "gh-fixture-skills-writer",
    displayName: "Writer",
    version: "aaaaaaaaaaaa",
    description: "fixture",
    visibility: "restricted",
    categories: [],
    ...(capability
      ? {
          registry: {
            identifier: "gh:fixture/skills/writer",
            sourceUrl: "https://github.com/fixture/skills",
            repoUrl: "https://github.com/fixture/skills",
            submittedBy: "owner",
            capability,
            scan: { reviewRequired: flags.length > 0, flags },
            fileManifest: [],
          },
        }
      : {}),
  };
}

describe("describeVersionEscalation", () => {
  test("gaining scripts is an escalation; losing them or keeping them is not", () => {
    expect(
      describeVersionEscalation(manifest("prompt-only"), manifest("executable")),
    ).toEqual({ addsScripts: true, newFlags: [] });
    expect(
      describeVersionEscalation(manifest("executable"), manifest("prompt-only")),
    ).toBeNull();
    expect(
      describeVersionEscalation(manifest("executable"), manifest("executable")),
    ).toBeNull();
    expect(
      describeVersionEscalation(
        manifest("prompt-only"),
        manifest("prompt-only"),
      ),
    ).toBeNull();
  });

  test("only flags the installed version does not already carry count", () => {
    expect(
      describeVersionEscalation(
        manifest("prompt-only", ["network-access"]),
        manifest("prompt-only", ["network-access", "shell", "shell"]),
      ),
    ).toEqual({ addsScripts: false, newFlags: ["shell"] });
    expect(
      describeVersionEscalation(
        manifest("prompt-only", ["network-access", "shell"]),
        manifest("prompt-only", ["shell"]),
      ),
    ).toBeNull();
    expect(
      describeVersionEscalation(
        manifest("prompt-only"),
        manifest("executable", ["shell"]),
      ),
    ).toEqual({ addsScripts: true, newFlags: ["shell"] });
  });

  test("a manifest without a registry block counts as prompt-only with no flags", () => {
    expect(
      describeVersionEscalation(manifest(null), manifest("executable")),
    ).toEqual({ addsScripts: true, newFlags: [] });
    expect(
      describeVersionEscalation(manifest("executable", ["shell"]), manifest(null)),
    ).toBeNull();
  });
});
