import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

vi.mock("../../sources/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sources/storage")>();
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

const API = "https://api.test";

let schema: typeof import("@sourceweft/db");
let threads: typeof import("../service").contentThreadService;
let shares: typeof import("./service").threadShareService;
let sharing: typeof import("../../sharing").sharingService;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let owner: string;
let member: string;
let admin: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("thread_share");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  ({ contentThreadService: threads } = await import("../service"));
  ({ threadShareService: shares } = await import("./service"));
  ({ sharingService: sharing } = await import("../../sharing"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, owner, member, admin] = [
    randomUUID(),
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
    name: "Share",
    slug: workspaceId,
  });
  for (const [id, name] of [
    [owner, "Thans"],
    [member, "Member"],
    [admin, "Admin"],
  ]) {
    await schema.database.query(
      'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())',
      [id, name, `${id}@example.test`],
    );
  }
  // A guest's role is capped below workspace_admin, so the admin is an
  // organization member with a direct workspace membership.
  await schema.database.query(
    `insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $1, 'member', now())`,
    [admin, teamId],
  );
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: owner, role: "editor", source: "guest" },
    { workspaceId, userId: member, role: "editor", source: "guest" },
    { workspaceId, userId: admin, role: "workspace_admin", source: "direct" },
  ]);
});

afterEach(async () => {
  await schema.db
    .delete(schema.shareLinks)
    .where(eq(schema.shareLinks.workspaceId, workspaceId));
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

async function chat(
  title: string,
  options: { visibility?: "private" | "workspace" } = {},
) {
  const { thread } = await threads.createThread({
    workspaceId,
    userId: owner,
    title,
  });
  if (options.visibility === "workspace") {
    await threads.updateThreadVisibility({
      workspaceId,
      threadId: thread.id,
      userId: owner,
      visibility: "workspace",
    });
  }
  return thread;
}

async function artifact(input: {
  type: "image" | "report";
  title: string;
  storageKey?: string;
}) {
  const id = randomUUID();
  await schema.db.insert(schema.artifacts).values({
    id,
    teamId,
    workspaceId,
    artifactType: input.type,
    status: "ready",
    title: input.title,
    visibility: "workspace",
    createdBy: owner,
    storageKey: input.storageKey ?? null,
  });
  return id;
}

function scope(threadId: string, userId = owner) {
  return { workspaceId, threadId, userId };
}

async function shareOk(threadId: string, userId = owner) {
  const result = await shares.shareThread(scope(threadId, userId));
  if (!result.ok) return assert.fail(`share failed: ${result.reason}`);
  return result.value;
}

test("the creator shares a chat and the public view shows the snapshot", async () => {
  const thread = await chat("Budget");
  await message(thread.id, { content: "How are we doing?" });
  await message(thread.id, { role: "assistant", content: "Over plan." });

  const share = await shareOk(thread.id);
  assert.match(share.url, new RegExp(`/chat/${share.token}$`));
  assert.equal(share.targetType, "thread");
  assert.equal(share.noindex, true);
  assert.ok(share.snapshotTakenAt);

  const got = await shares.getThreadShare(scope(thread.id));
  assert.deepEqual(got, { ok: true, value: share });

  const chatView = await shares.resolvePublicChat(share.token, API);
  assert.ok(chatView);
  assert.equal(chatView.title, "Budget");
  assert.equal(chatView.noindex, true);
  assert.deepEqual(
    chatView.messages.map((m) => [m.role, m.content]),
    [
      ["user", "How are we doing?"],
      ["assistant", "Over plan."],
    ],
  );

  const audits = await schema.db
    .select()
    .from(schema.teamAuditLogs)
    .where(
      and(
        eq(schema.teamAuditLogs.teamId, teamId),
        eq(schema.teamAuditLogs.targetId, thread.id),
      ),
    );
  assert.deepEqual(
    audits.map((row) => [row.action, row.targetType]),
    [["thread.shared", "thread"]],
  );
});

test("a workspace admin shares the owner's workspace-visible chat", async () => {
  const thread = await chat("Team notes", { visibility: "workspace" });
  await message(thread.id, { content: "Hi" });

  const share = await shareOk(thread.id, admin);
  assert.equal(share.targetId, thread.id);
});

test("another editor cannot share a workspace-visible chat they did not create", async () => {
  const thread = await chat("Team notes", { visibility: "workspace" });
  assert.deepEqual(await shares.shareThread(scope(thread.id, member)), {
    ok: false,
    reason: "forbidden",
  });
});

test("another member's private chat is not found", async () => {
  const thread = await chat("Private");
  assert.deepEqual(await shares.shareThread(scope(thread.id, member)), {
    ok: false,
    reason: "not_found",
  });
  assert.deepEqual(await shares.getThreadShare(scope(thread.id, member)), {
    ok: false,
    reason: "not_found",
  });
});

test("a sub-agent chat cannot be shared", async () => {
  const parent = await chat("Parent");
  const { thread: child } = await threads.createThread({
    workspaceId,
    userId: owner,
    title: "Child",
    parentThreadId: parent.id,
  });
  assert.deepEqual(await shares.shareThread(scope(child.id)), {
    ok: false,
    reason: "not_found",
  });
});

test("the public view is frozen until the chat is shared again on the same link", async () => {
  const thread = await chat("Before");
  await message(thread.id, { content: "First" });
  const first = await shareOk(thread.id);
  const frozen = await shares.resolvePublicChat(first.token, API);

  await threads.renameThread({
    workspaceId,
    threadId: thread.id,
    userId: owner,
    title: "After",
  });
  await message(thread.id, { content: "Second" });
  assert.deepEqual(await shares.resolvePublicChat(first.token, API), frozen);

  const again = await shareOk(thread.id);
  assert.equal(again.token, first.token);
  const updated = await shares.resolvePublicChat(first.token, API);
  assert.equal(updated?.title, "After");
  assert.deepEqual(
    updated?.messages.map((m) => m.content),
    ["First", "Second"],
  );

  const actions = await schema.db
    .select({ action: schema.teamAuditLogs.action })
    .from(schema.teamAuditLogs)
    .where(eq(schema.teamAuditLogs.targetId, thread.id));
  assert.deepEqual(actions.map((row) => row.action).sort(), [
    "thread.share_updated",
    "thread.shared",
  ]);
});

test("noindex can be changed on a live share", async () => {
  const thread = await chat("Indexed");
  await shareOk(thread.id);
  const result = await shares.updateThreadShare({
    ...scope(thread.id),
    noindex: false,
  });
  assert.ok(result.ok);
  assert.equal(result.value.noindex, false);
});

test("stopping sharing removes the public view", async () => {
  const thread = await chat("Stop");
  await message(thread.id, { content: "Hi" });
  const share = await shareOk(thread.id);

  assert.deepEqual(await shares.revokeThreadShare(scope(thread.id)), {
    ok: true,
    value: true,
  });
  assert.equal(await shares.resolvePublicChat(share.token, API), null);
  assert.deepEqual(await shares.getThreadShare(scope(thread.id)), {
    ok: true,
    value: null,
  });
  const snapshots = await schema.db
    .select()
    .from(schema.threadShareSnapshots)
    .where(eq(schema.threadShareSnapshots.threadId, thread.id));
  assert.equal(snapshots.length, 0);
});

test("deleting the chat revokes its share and removes the snapshot", async () => {
  const thread = await chat("Doomed");
  await message(thread.id, { content: "Hi" });
  const share = await shareOk(thread.id);

  await threads.deleteThread(scope(thread.id));

  assert.equal(await shares.resolvePublicChat(share.token, API), null);
  const snapshots = await schema.db
    .select()
    .from(schema.threadShareSnapshots)
    .where(eq(schema.threadShareSnapshots.threadId, thread.id));
  assert.equal(snapshots.length, 0);
  const [link] = await schema.db
    .select()
    .from(schema.shareLinks)
    .where(eq(schema.shareLinks.token, share.token));
  assert.ok(link?.revokedAt);
});

test("turning the chat private keeps the shared snapshot public", async () => {
  const thread = await chat("Flip", { visibility: "workspace" });
  await message(thread.id, { content: "Hi" });
  const share = await shareOk(thread.id);

  await threads.updateThreadVisibility({
    ...scope(thread.id),
    visibility: "private",
  });

  const view = await shares.resolvePublicChat(share.token, API);
  assert.equal(view?.title, "Flip");
});

test("an artifact card links to the artifact only while it is shared", async () => {
  const report = await artifact({ type: "report", title: "Q3 summary" });
  const thread = await chat("Reports", { visibility: "workspace" });
  await message(thread.id, { content: "Make a report" });
  await message(thread.id, {
    role: "assistant",
    content: "Done.",
    metadata: {
      renderBlocks: [{ type: "artifact_output", artifactId: report }],
    },
  });
  const share = await shareOk(thread.id);

  const before = await shares.resolvePublicChat(share.token, API);
  assert.deepEqual(before?.messages[1]?.artifacts, [
    { kind: "report", title: "Q3 summary", publicUrl: null },
  ]);

  const artifactShare = await sharing.shareArtifact({
    workspaceId,
    artifactId: report,
    userId: owner,
  });
  if (!artifactShare.ok) return assert.fail("artifact share failed");
  const after = await shares.resolvePublicChat(share.token, API);
  assert.match(
    after?.messages[1]?.artifacts[0]?.publicUrl ?? "",
    new RegExp(`/artifact/${artifactShare.value.token}$`),
  );
});

test("a token of the other share type resolves to nothing", async () => {
  const report = await artifact({ type: "report", title: "Q3 summary" });
  const artifactShare = await sharing.shareArtifact({
    workspaceId,
    artifactId: report,
    userId: owner,
  });
  if (!artifactShare.ok) return assert.fail("artifact share failed");
  assert.equal(
    await shares.resolvePublicChat(artifactShare.value.token, API),
    null,
  );

  const thread = await chat("Chat");
  await message(thread.id, { content: "Hi" });
  const share = await shareOk(thread.id);
  assert.equal(await sharing.resolvePublicArtifact(share.token), null);
});

test("images are served by number from the snapshot", async () => {
  const cat = await artifact({
    type: "image",
    title: "A sleeping cat",
    storageKey: "art-ok-cat.png",
  });
  const thread = await chat("Pictures", { visibility: "workspace" });
  await message(thread.id, {
    content: "See",
    images: [{ name: "chart.png", key: "ok-1" }],
  });
  await message(thread.id, {
    role: "assistant",
    content: "Here is a cat.",
    metadata: {
      renderBlocks: [{ type: "artifact_output", artifactId: cat }],
    },
  });
  const share = await shareOk(thread.id);

  const view = await shares.resolvePublicChat(share.token, API);
  const imageUrl = (n: number) =>
    `${API}/v1/public/shares/${share.token}/chat/images/${n}`;
  assert.deepEqual(view?.messages[0]?.images, [
    { name: "chart.png", url: imageUrl(1) },
  ]);
  assert.deepEqual(view?.messages[1]?.images, [
    { name: "A sleeping cat", url: imageUrl(2) },
  ]);

  const attachment = await shares.resolvePublicChatImage(share.token, 1);
  assert.equal(Buffer.from(attachment!.body).toString(), "PNG");
  assert.equal(attachment!.contentType, "image/png");
  const generated = await shares.resolvePublicChatImage(share.token, 2);
  assert.equal(Buffer.from(generated!.body).toString(), "GEN");
  assert.equal(await shares.resolvePublicChatImage(share.token, 99), null);
});

test("an image reference in the content becomes a public image URL", async () => {
  const cat = await artifact({
    type: "image",
    title: "Cat",
    storageKey: "art-ok-cat.png",
  });
  const thread = await chat("Inline");
  await message(thread.id, { content: "Draw" });
  await message(thread.id, {
    role: "assistant",
    content: `Look: ![cat](/v1/workspaces/${workspaceId}/artifacts/${cat}/file)`,
    metadata: {
      renderBlocks: [{ type: "artifact_output", artifactId: cat }],
    },
  });
  const share = await shareOk(thread.id);

  const view = await shares.resolvePublicChat(share.token, API);
  assert.equal(
    view?.messages[1]?.content,
    `Look: ![Cat](${API}/v1/public/shares/${share.token}/chat/images/1)`,
  );
  assert.deepEqual(view?.messages[1]?.images, []);
});
