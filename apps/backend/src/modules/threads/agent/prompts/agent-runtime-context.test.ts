import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createSyntheticRuntimePromptProvider,
  SYNTHETIC_PROMPT_MARKER,
  SYNTHETIC_TOOL_NAME,
} from "../../../../test/synthetic-capability";
import { buildAgentRuntimeContext } from "./agent-runtime-context";
import type { ArtifactToolRuntimePromptProvider } from "./tool-prompt-provider";

// The catalog rule costs tokens and changes behaviour, so it appears only when
// the turn can actually act on it.
test("the skill catalog rule is present only when the catalog tools are bound", () => {
  const without = buildAgentRuntimeContext({ timezone: "UTC" });
  assert.equal(without.includes("<skill_catalog>"), false);

  const withCatalog = buildAgentRuntimeContext({
    timezone: "UTC",
    skillCatalogAvailable: true,
  });
  assert.match(
    withCatalog,
    /<skill_catalog>[\s\S]*search_skills[\s\S]*install_skill[\s\S]*<\/skill_catalog>/,
  );
  // Measured live: without an explicit carve-out the alternative failure is a
  // search on every turn.
  assert.match(withCatalog, /Do NOT search for ordinary questions/);
});

describe("from runner.test.ts", () => {
  test("runtime prompt maps selected source mention labels to kb paths", () => {
    const prompt = buildAgentRuntimeContext({
      timezone: "UTC",
      availableWebTools: [],
      selectedSources: [
        {
          sourceId: "043e27f7-c8e0-438e-a47f-adcf8b06088e",
          sourceType: "file_upload",
          parentSourceId: null,
          title: "043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
          fileName: "043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
          safeName: "043e27f7-c8e0-438e-a47f-adcf8b06088e",
          shortId: "043e27f7",
          filePath: "/kb/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7.md",
          dirPath: "/kb/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7",
          readmePath: null,
          chunkCount: 4,
          sizeBytes: 12000,
          mimeType: "application/pdf",
          updatedAt: "2026-05-09T00:00:00.000Z",
        },
      ],
      selectedSourcesOmitted: 0,
    });

    assert.match(prompt, /<selected_source_manifest>/);
    assert.match(prompt, /@043e27f7-c8e0-438e-a47f-adcf8b06088e\.pdf/);
    assert.match(
      prompt,
      /kb_path="\/kb\/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7\.md"/,
    );
    assert.match(prompt, /Do not synthesize \/files\/<filename>/);
    assert.match(prompt, /\/files contains only thread Files/);
  });

  test("runtime prompt lists only available public web tools", () => {
    const fetchOnlyPrompt = buildAgentRuntimeContext({
      timezone: "UTC",
      availableWebTools: ["web_fetch"],
    });
    assert.match(
      fetchOnlyPrompt,
      /Available public web tools this turn: web_fetch\./,
    );
    assert.doesNotMatch(fetchOnlyPrompt, /web_search and web_fetch/);

    const searchAndFetchPrompt = buildAgentRuntimeContext({
      timezone: "UTC",
      availableWebTools: ["web_search", "web_fetch"],
    });
    assert.match(
      searchAndFetchPrompt,
      /Available public web tools this turn: web_search, web_fetch\./,
    );
  });

  test("runtime prompt points active skills at SKILL.md without preloading content", () => {
    const prompt = buildAgentRuntimeContext({
      timezone: "UTC",
      enabledSkills: [
        {
          workspaceSkillId: "skill-1",
          sourceType: "builtin",
          name: "feynman",
          version: "1.0.0",
          description: "Explain concepts in simple steps.",
          files: [
            {
              path: "SKILL.md",
              mimeType: "text/markdown",
              sizeBytes: 40,
              contentHash: "hash",
              isText: true,
            },
          ],
          skillMd: "Explain with simple analogies and check understanding.",
        },
      ],
      invokedSkillIds: ["skill-1"],
    });

    assert.match(prompt, /<active_skills>/);
    assert.match(prompt, /name="feynman"/);
    assert.match(prompt, /skill_path="\/skills\/feynman\/SKILL\.md"/);
    assert.match(prompt, /read_required="true"/);
    assert.match(prompt, /strong instruction, not a suggestion/);
    assert.doesNotMatch(
      prompt,
      /Explain with simple analogies and check understanding\./,
    );
  });

  test("runtime prompt does not force-read default selected skills", () => {
    const prompt = buildAgentRuntimeContext({
      timezone: "UTC",
      enabledSkills: [
        {
          workspaceSkillId: "builtin:ppt-deck",
          sourceType: "builtin",
          name: "ppt-deck",
          version: "1.0.0",
          description: "Create PPT decks.",
          files: [],
        },
        {
          workspaceSkillId: "builtin:image-generate",
          sourceType: "builtin",
          name: "image-generate",
          version: "1.0.0",
          description: "Generate image artifacts.",
          files: [],
        },
      ],
      invokedSkillIds: [],
    });

    assert.doesNotMatch(prompt, /<active_skills>/);
    assert.doesNotMatch(prompt, /\/skills\/ppt-deck\/SKILL\.md/);
    assert.doesNotMatch(prompt, /\/skills\/image-generate\/SKILL\.md/);
    assert.doesNotMatch(prompt, /read_required="true"/);
  });

  test("runtime prompt exposes invoked skill runtime config", () => {
    const prompt = buildAgentRuntimeContext({
      timezone: "UTC",
      invokedSkillIds: ["skill-1"],
      enabledSkills: [
        {
          workspaceSkillId: "skill-1",
          sourceType: "builtin",
          name: "ppt-deck",
          displayName: "PPT Deck",
          version: "1.0.0",
          description: "Create PPT decks.",
          defaultConfig: {
            config: {
              language: "zh-CN",
              slideCount: 10,
              stylePreset: "editorial",
              visualDensity: "dense",
            },
          },
          files: [],
        },
      ],
    });

    assert.match(prompt, /<skill_runtime_config name="ppt-deck">/);
    assert.match(prompt, /User-selected options for this skill/);
    assert.match(prompt, /generation constraints/);
    assert.match(prompt, /stylePreset: editorial/);
    assert.match(prompt, /visualDensity: dense/);
    assert.match(prompt, /language: zh-CN/);
    assert.match(prompt, /slideCount: 10/);
  });

  /**
   * The host's half of the runtime-prompt contract: whatever a capability's
   * provider returns is appended to the artifact-tools section, verbatim and
   * unfiltered, and the section appears even when no artifact tool is bound.
   *
   * Driven by a synthetic provider on purpose. Asserting a real capability's
   * prompt wording here tested the capability, not this function, and broke on
   * copy edits made in another package; those assertions now live with the
   * providers that produce them (see the generate-image and publish-artifact
   * packages' prompt-provider tests).
   */
  test("runtime prompt appends capability provider lines verbatim", () => {
    const prompt = buildAgentRuntimeContext({
      timezone: "UTC",
      availableArtifactTools: [SYNTHETIC_TOOL_NAME],
      artifactToolRuntimePromptProviders: [
        createSyntheticRuntimePromptProvider() as ArtifactToolRuntimePromptProvider,
      ],
    });

    assert.ok(
      prompt.includes(
        `Available artifact tools this turn: ${SYNTHETIC_TOOL_NAME}.`,
      ),
    );
    assert.ok(prompt.includes(SYNTHETIC_PROMPT_MARKER));
  });

  test("runtime prompt keeps provider lines when no artifact tool is bound", () => {
    const prompt = buildAgentRuntimeContext({
      timezone: "UTC",
      availableArtifactTools: [],
      artifactToolRuntimePromptProviders: [
        createSyntheticRuntimePromptProvider() as ArtifactToolRuntimePromptProvider,
      ],
    });

    assert.ok(prompt.includes(SYNTHETIC_PROMPT_MARKER));
  });

  test("runtime prompt omits the artifact-tools section when nothing contributes", () => {
    const prompt = buildAgentRuntimeContext({
      timezone: "UTC",
      availableArtifactTools: [],
      artifactToolRuntimePromptProviders: [
        createSyntheticRuntimePromptProvider(
          [],
        ) as ArtifactToolRuntimePromptProvider,
      ],
    });

    assert.ok(!prompt.includes("Available artifact tools this turn"));
    assert.ok(!prompt.includes(SYNTHETIC_PROMPT_MARKER));
  });
});
