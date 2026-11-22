import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

vi.mock("../../sources/storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sources/storage")>();
  return {
    ...actual,
    downloadChatImageObject: vi.fn(async (input: { key: string }) => {
      if (input.key.startsWith("ok")) {
        return Buffer.from("PNG");
      }
      throw new Error("storage unavailable");
    }),
    downloadArtifactObject: vi.fn(async (input: { key: string }) => {
      if (input.key.startsWith("art-ok")) {
        return Buffer.from("GEN");
      }
      throw new Error("storage unavailable");
    }),
  };
});

let schema: typeof import("@sourceweft/db");
let threads: typeof import("../service").contentThreadService;
let exportThread: typeof import("./service").exportThread;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let owner: string;
let member: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("thread_export");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  ({ contentThreadService: threads } = await import("../service"));
  ({ exportThread } = await import("./service"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, owner, member] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await schema.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Export",
    slug: workspaceId,
  });
  for (const [id, name] of [
    [owner, "Thans"],
    [member, "Member"],
  ]) {
    await schema.database.query(
      'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())',
      [id, name, `${id}@example.test`],
    );
  }
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: owner, role: "editor", source: "guest" },
    { workspaceId, userId: member, role: "editor", source: "guest" },
  ]);
});

afterEach(async () => {
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  await isolated?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

let clock = 0;
async function message(
  threadId: string,
  input: {
    role?: "user" | "assistant";
    content?: string;
    parentMessageId?: string;
    metadata?: Record<string, unknown>;
    images?: Array<{ name: string; key: string }>;
  } = {},
) {
  clock += 1;
  const id = randomUUID();
  await schema.db.insert(schema.messages).values({
    id,
    teamId,
    workspaceId,
    threadId,
    role: input.role ?? "user",
    content: input.content ?? "",
    createdBy: (input.role ?? "user") === "user" ? owner : null,
    parentMessageId: input.parentMessageId ?? null,
    metadata: input.metadata ?? {},
    contentJson: input.images
      ? {
          version: 1,
          parts: input.images.map((image) => ({
            type: "image",
            id: randomUUID(),
            fileName: image.name,
            mimeType: "image/png",
            sizeBytes: 3,
            storageKey: image.key,
            url: "/x",
          })),
        }
      : {},
    createdAt: new Date(Date.UTC(2026, 10, 20, 2, 0, clock)),
  });
  return id;
}

async function chat(title: string) {
  const { thread } = await threads.createThread({
    workspaceId,
    userId: owner,
    title,
  });
  return thread;
}

function run(threadId: string, userId = owner) {
  return exportThread({
    workspaceId,
    threadId,
    userId,
    locale: "en",
    timeZone: "UTC",
  });
}

async function unzip(stream: ReadableStream<Uint8Array>) {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return unzipSync(bytes);
}

test("a text chat exports the newest versions as Markdown", async () => {
  const thread = await chat("Budget");
  const first = await message(thread.id, { content: "Old question" });
  await message(thread.id, { content: "New question", parentMessageId: first });
  await message(thread.id, {
    role: "assistant",
    content: "Over plan.[citation:c1]",
    metadata: {
      retrieval: {
        citations: [
          { citation: "c1", sourceTitle: "Q3.xlsx", excerpt: "118% of plan" },
        ],
      },
    },
  });
  await message(thread.id, {
    role: "assistant",
    content: "boom",
    metadata: { isError: true },
  });

  const result = await run(thread.id);
  assert.equal(result.kind, "markdown");
  assert.equal(result.fileName, "Budget.md");
  if (result.kind !== "markdown") return;
  assert.match(result.text, /^## Thans · /m);
  assert.match(result.text, /New question/);
  assert.doesNotMatch(result.text, /Old question|boom/);
  assert.match(result.text, /Over plan\.\[\^1\]/);
  assert.match(result.text, /\[\^1\]: Q3\.xlsx — "118% of plan"/);
});

test("the answer still being generated is left out", async () => {
  const thread = await chat("Running");
  const userMessageId = await message(thread.id, { content: "Q" });
  const answer = await message(thread.id, {
    role: "assistant",
    content: "half an ans",
  });
  await schema.db.insert(schema.chatThreadRuns).values({
    id: randomUUID(),
    teamId,
    workspaceId,
    threadId: thread.id,
    userId: owner,
    userMessageId,
    assistantMessageId: answer,
    idempotencyKey: randomUUID(),
    mode: "send",
    streamKey: randomUUID(),
    status: "running",
  });

  const result = await run(thread.id);
  assert.equal(result.kind, "markdown");
  if (result.kind !== "markdown") return;
  assert.doesNotMatch(result.text, /half an ans/);
});

test("another member's private chat is not found", async () => {
  const thread = await chat("Private");
  await assert.rejects(run(thread.id, member), {
    code: "THREAD_NOT_FOUND",
  });
});

test("a chat with an image exports a zip with the image file", async () => {
  const thread = await chat("Charts");
  await message(thread.id, {
    content: "See",
    images: [{ name: "my chart.png", key: "ok-1" }],
  });

  const result = await run(thread.id);
  assert.equal(result.kind, "zip");
  assert.equal(result.fileName, "Charts.zip");
  if (result.kind !== "zip") return;
  const files = await unzip(result.stream);
  assert.deepEqual(Object.keys(files).sort(), [
    "Charts.md",
    "images/01-my-chart.png",
  ]);
  assert.equal(strFromU8(files["images/01-my-chart.png"]!), "PNG");
  assert.match(
    strFromU8(files["Charts.md"]!),
    /!\[my chart\.png\]\(images\/01-my-chart\.png\)/,
  );
});

test("image file names keep only link-safe characters so the link opens", async () => {
  const thread = await chat("Odd names");
  await message(thread.id, {
    content: "See",
    images: [{ name: "report#2 (final).png", key: "ok-odd" }],
  });

  const result = await run(thread.id);
  if (result.kind !== "zip") return assert.fail("expected a zip");
  const files = await unzip(result.stream);
  assert.deepEqual(Object.keys(files).sort(), [
    "Odd names.md",
    "images/01-report-2-final.png",
  ]);
  assert.match(
    strFromU8(files["Odd names.md"]!),
    /!\[report#2 \(final\)\.png\]\(images\/01-report-2-final\.png\)/,
  );
});

async function artifact(input: {
  workspace?: string;
  type: "image" | "report";
  title: string;
  status?: "ready" | "pending";
  visibility?: "workspace" | "private";
  createdBy?: string;
  storageKey?: string;
}) {
  const id = randomUUID();
  await schema.db.insert(schema.artifacts).values({
    id,
    teamId,
    workspaceId: input.workspace ?? workspaceId,
    artifactType: input.type,
    status: input.status ?? "ready",
    title: input.title,
    visibility: input.visibility ?? "workspace",
    createdBy: input.createdBy ?? owner,
    storageKey: input.storageKey ?? null,
  });
  return id;
}

test("a reply's artifacts export as images and links, only those the member can see", async () => {
  const otherWorkspace = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: otherWorkspace,
    organizationId: teamId,
    name: "Elsewhere",
    slug: otherWorkspace,
  });
  try {
    const image = await artifact({
      type: "image",
      title: "A sleeping cat",
      storageKey: "art-ok-cat.png",
    });
    const report = await artifact({ type: "report", title: "Q3 summary" });
    const hidden = await artifact({
      type: "report",
      title: "Secret plan",
      visibility: "private",
      createdBy: member,
    });
    const unfinished = await artifact({
      type: "report",
      title: "Draft in progress",
      status: "pending",
    });
    const elsewhere = await artifact({
      workspace: otherWorkspace,
      type: "report",
      title: "Other workspace report",
    });

    const thread = await chat("Artifacts");
    await message(thread.id, { content: "Make things" });
    await message(thread.id, {
      role: "assistant",
      content: "Done.",
      metadata: {
        renderBlocks: [image, report, hidden, unfinished, elsewhere].map(
          (artifactId) => ({ type: "artifact_output", artifactId }),
        ),
      },
    });

    const result = await run(thread.id);
    if (result.kind !== "zip") return assert.fail(`expected a zip: ${result.text}`);
    const files = await unzip(result.stream);
    assert.deepEqual(Object.keys(files).sort(), [
      "Artifacts.md",
      "images/01-A-sleeping-cat.png",
    ]);
    assert.equal(strFromU8(files["images/01-A-sleeping-cat.png"]!), "GEN");

    const markdown = strFromU8(files["Artifacts.md"]!);
    assert.match(
      markdown,
      /!\[A sleeping cat\]\(images\/01-A-sleeping-cat\.png\)/,
    );
    assert.match(
      markdown,
      new RegExp(`\\[Report: Q3 summary\\]\\(http[^)]*artifactId=${report}`),
    );
    assert.doesNotMatch(markdown, /Secret plan|Draft in progress|Other workspace/);
  } finally {
    await schema.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, otherWorkspace));
  }
});

test("an image that fails to load becomes a placeholder", async () => {
  const thread = await chat("Broken");
  await message(thread.id, {
    content: "See",
    images: [{ name: "lost.png", key: "bad-1" }],
  });

  const result = await run(thread.id);
  assert.equal(result.kind, "zip");
  if (result.kind !== "zip") return;
  const files = await unzip(result.stream);
  assert.deepEqual(Object.keys(files), ["Broken.md"]);
  assert.match(
    strFromU8(files["Broken.md"]!),
    /\[Image unavailable: lost\.png\]/,
  );
});

test("images beyond the count limit become placeholders", async () => {
  const thread = await chat("Many");
  await message(thread.id, {
    content: "See",
    images: [
      { name: "a.png", key: "ok-a" },
      { name: "b.png", key: "ok-b" },
    ],
  });

  const result = await exportThread({
    workspaceId,
    threadId: thread.id,
    userId: owner,
    locale: "en",
    timeZone: "UTC",
    limits: { count: 1, bytes: 1024 },
  });
  assert.equal(result.kind, "zip");
  if (result.kind !== "zip") return;
  const files = await unzip(result.stream);
  assert.deepEqual(Object.keys(files).sort(), ["Many.md", "images/01-a.png"]);
  assert.match(strFromU8(files["Many.md"]!), /\[Image unavailable: b\.png\]/);
});

test("images beyond the byte limit become placeholders", async () => {
  const thread = await chat("Big");
  await message(thread.id, {
    content: "See",
    images: [
      { name: "a.png", key: "ok-a" },
      { name: "b.png", key: "ok-b" },
    ],
  });

  const result = await exportThread({
    workspaceId,
    threadId: thread.id,
    userId: owner,
    locale: "en",
    timeZone: "UTC",
    limits: { count: 50, bytes: 4 },
  });
  if (result.kind !== "zip") return assert.fail("expected a zip");
  const files = await unzip(result.stream);
  assert.deepEqual(Object.keys(files).sort(), ["Big.md", "images/01-a.png"]);
});
