import { describe, expect, it } from "vitest";
import type { Persona } from "@sourceweft/contracts";
import {
  createPayloadFromDraft,
  describePersonaSource,
  draftFromPersona,
  groupPersonas,
  isDraftComplete,
  payloadFromDraft,
  toggleAllowlistTool,
} from "./persona-helpers";

const explore: Persona = {
  id: "explore",
  slug: "explore",
  name: "Explore",
  description: "Read-only investigation.",
  systemPrompt: "Investigate.",
  avatar: null,
  trust: "system",
  modelSettings: null,
  toolAllowlist: ["search_sources"],
  filesystemPolicy: "read_only",
  clonedFrom: null,
  createdBy: null,
  updatedAt: null,
};

const verifier: Persona = {
  ...explore,
  id: "persona_1",
  slug: "verifier",
  name: "Verifier",
  trust: "user",
  modelSettings: { llmProfileAlias: "chat-fast" },
  toolAllowlist: null,
  filesystemPolicy: "default",
  clonedFrom: "explore",
  createdBy: "user_1",
  updatedAt: "2026-09-09T00:00:00.000Z",
};

describe("persona helpers", () => {
  it("groups built-ins ahead of workspace personas", () => {
    const grouped = groupPersonas([verifier, explore]);
    expect(grouped.builtIn.map((persona) => persona.id)).toEqual(["explore"]);
    expect(grouped.custom.map((persona) => persona.id)).toEqual(["persona_1"]);
  });

  it("round-trips a persona through the editor draft", () => {
    const draft = draftFromPersona(verifier);
    expect(draft).toEqual({
      name: "Verifier",
      description: "Read-only investigation.",
      systemPrompt: "Investigate.",
      llmProfileAlias: "chat-fast",
      toolAllowlist: null,
      readOnly: false,
    });
    expect(payloadFromDraft({ ...draft, name: " Verifier  " })).toEqual({
      name: "Verifier",
      description: "Read-only investigation.",
      systemPrompt: "Investigate.",
      modelSettings: { llmProfileAlias: "chat-fast" },
      toolAllowlist: null,
      filesystemPolicy: "default",
    });
    expect(
      payloadFromDraft({ ...draftFromPersona(explore), llmProfileAlias: " " }),
    ).toMatchObject({
      modelSettings: null,
      toolAllowlist: ["search_sources"],
      filesystemPolicy: "read_only",
    });
    expect(createPayloadFromDraft("explore", draft).sourceId).toBe("explore");
  });

  it("toggles tools without collapsing 'all tools' to a single pick", () => {
    const available = ["search_sources", "web_search", "web_fetch"];
    expect(toggleAllowlistTool(null, "web_search", available)).toEqual([
      "search_sources",
      "web_fetch",
    ]);
    expect(
      toggleAllowlistTool(["search_sources"], "web_fetch", available),
    ).toEqual(["search_sources", "web_fetch"]);
    expect(
      toggleAllowlistTool(["search_sources"], "search_sources", available),
    ).toEqual([]);
  });

  it("describes a persona's source by name when it is still listed", () => {
    expect(describePersonaSource(verifier, [explore, verifier])).toBe(
      "Explore",
    );
    expect(describePersonaSource(verifier, [verifier])).toBe("explore");
    expect(describePersonaSource(explore, [explore])).toBeNull();
  });

  it("requires a name and instructions before saving", () => {
    expect(isDraftComplete(draftFromPersona(explore))).toBe(true);
    expect(
      isDraftComplete({ ...draftFromPersona(explore), systemPrompt: " " }),
    ).toBe(false);
  });
});
