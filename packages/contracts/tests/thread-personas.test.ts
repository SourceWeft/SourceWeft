import assert from "node:assert/strict";
import test from "node:test";
import { listPersonasResponseSchema, personaSchema } from "../src/personas";
import {
  createThreadRequestSchema,
  listThreadsResponseSchema,
  threadOriginSchema,
  threadSchema,
} from "../src/threads";

const baseThread = {
  id: "thread_1",
  teamId: "team_1",
  workspaceId: "workspace_1",
  title: "Multi agent proofs",
  modelSettings: {
    llmModelAlias: null,
    imageModelAlias: null,
    visionModelAlias: null,
  },
  sourceCount: 0,
  visibility: "workspace",
  parentThreadId: null,
  personaId: null,
  origin: "user",
  createdBy: "user_1",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  lastMessageAt: null,
  chatPreferences: {},
};

test("a thread carries its parent link, persona, and origin", () => {
  assert.deepEqual(threadOriginSchema.options, ["user", "subagent"]);
  const child = threadSchema.parse({
    ...baseThread,
    id: "thread_2",
    parentThreadId: "thread_1",
    personaId: "explore",
    origin: "subagent",
  });
  assert.equal(child.parentThreadId, "thread_1");
  assert.equal(child.personaId, "explore");
  assert.equal(child.origin, "subagent");
  assert.equal(
    threadSchema.safeParse({ ...baseThread, origin: "delegate" }).success,
    false,
  );
});

test("the thread list nests one level of children under each item", () => {
  const parsed = listThreadsResponseSchema.parse({
    items: [
      {
        ...baseThread,
        children: [
          {
            ...baseThread,
            id: "thread_2",
            parentThreadId: "thread_1",
            personaId: "plan",
          },
        ],
      },
    ],
    nextCursor: null,
  });
  assert.equal(parsed.items[0]?.children?.[0]?.personaId, "plan");
  // A child row is a plain thread: it does not carry children of its own.
  assert.equal("children" in (parsed.items[0]?.children?.[0] ?? {}), false);
});

test("creating a thread may name a parent and a persona, but never blank ones", () => {
  const parsed = createThreadRequestSchema.parse({
    parentThreadId: " thread_1 ",
    personaId: "explore",
  });
  assert.equal(parsed.parentThreadId, "thread_1");
  assert.equal(parsed.personaId, "explore");
  assert.equal(
    createThreadRequestSchema.safeParse({ personaId: "   " }).success,
    false,
  );
  assert.equal(createThreadRequestSchema.parse({}).parentThreadId, undefined);
});

test("a persona is shaped like a deepagents SubAgent declaration", () => {
  const persona = personaSchema.parse({
    slug: "explore",
    name: "Explore",
    description: "Read-only investigation delegate.",
    systemPrompt: "You are a focused investigation delegate.",
    avatar: null,
    trust: "system",
    modelSettings: null,
    toolAllowlist: ["search_sources"],
  });
  assert.deepEqual(persona.toolAllowlist, ["search_sources"]);
  assert.equal(
    personaSchema.safeParse({ ...persona, trust: "builtin" }).success,
    false,
  );
  assert.equal(
    listPersonasResponseSchema.parse({ items: [persona] }).items.length,
    1,
  );
});
