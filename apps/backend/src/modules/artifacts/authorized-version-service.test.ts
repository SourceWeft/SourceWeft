import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  artifactVersions,
  artifacts,
  db,
  threads,
  workspaceMemberships,
  workspaces,
} from "@sourceweft/db";
import {
  createReadyArtifactRecord,
  findCurrentReadyArtifactVersionRecord,
  findReadyArtifactVersionRecord,
} from "./repository";
import {
  readAuthorizedArtifactRecord,
  readAuthorizedCurrentArtifactVersion,
} from "./authorized-version-service";

let teamId: string;
let workspaceId: string;
let threadId: string;
let creatorUserId: string;
let viewerUserId: string;

beforeEach(async () => {
  teamId = randomUUID();
  workspaceId = randomUUID();
  threadId = randomUUID();
  creatorUserId = randomUUID();
  viewerUserId = randomUUID();

  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Authorized artifact version test",
    slug: `authorized-artifact-version-${workspaceId}`,
  });
  await db.insert(workspaceMemberships).values([
    {
      workspaceId,
      userId: creatorUserId,
      role: "editor",
      source: "guest",
    },
    {
      workspaceId,
      userId: viewerUserId,
      role: "viewer",
      source: "guest",
    },
  ]);
  await db.insert(threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Authorized artifact version test",
    visibility: "workspace",
    createdBy: creatorUserId,
  });
});

afterEach(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
});

async function createReadyVideo(input?: {
  artifactId?: string;
  payload?: Record<string, unknown>;
}) {
  const artifactId = input?.artifactId ?? randomUUID();
  const payload = input?.payload ?? { project: { title: "Version one" } };
  const result = await createReadyArtifactRecord({
    artifactId,
    artifactType: "video_presentation",
    teamId,
    workspaceId,
    threadId,
    userId: creatorUserId,
    title: "Versioned video",
    prompt: "Build a versioned video",
    payload,
  });
  return { artifactId, payload, versionId: result.versionId };
}

test("the repository joins the exact current ready version and uses version content", async () => {
  const created = await createReadyVideo();
  const newerVersionId = randomUUID();

  // A newer history row must not win unless the artifact's current-version
  // pointer advances to it in the same publication transaction.
  await db.insert(artifactVersions).values({
    id: newerVersionId,
    teamId,
    workspaceId,
    artifactId: created.artifactId,
    versionNo: 2,
    contentJson: { project: { title: "Uncommitted version two" } },
    createdBy: creatorUserId,
  });
  // Deliberately drift the mutable projection too: version content remains the
  // authority for an exact-version edit load.
  await db
    .update(artifacts)
    .set({ payloadJson: { project: { title: "Mutable projection" } } })
    .where(eq(artifacts.id, created.artifactId));

  const found = await findCurrentReadyArtifactVersionRecord({
    teamId,
    workspaceId,
    artifactId: created.artifactId,
    expectedArtifactType: "video_presentation",
  });

  assert.equal(found?.versionId, created.versionId);
  assert.equal(found?.versionNo, 1);
  assert.equal(found?.currentVersionNo, 1);
  assert.deepEqual(found?.contentJson, created.payload);
  assert.equal(
    await findReadyArtifactVersionRecord({
      teamId,
      workspaceId,
      artifactId: created.artifactId,
      artifactVersionId: newerVersionId,
    }),
    null,
  );
});

test("the repository reads the requested historical version without falling forward", async () => {
  const created = await createReadyVideo({
    payload: { project: { title: "Immutable version one" } },
  });
  const newerVersionId = randomUUID();
  await db.insert(artifactVersions).values({
    id: newerVersionId,
    teamId,
    workspaceId,
    artifactId: created.artifactId,
    versionNo: 2,
    contentJson: { project: { title: "Version two" } },
    createdBy: creatorUserId,
  });
  await db
    .update(artifacts)
    .set({
      currentVersionNo: 2,
      payloadJson: { project: { title: "Mutable version two projection" } },
    })
    .where(eq(artifacts.id, created.artifactId));

  const found = await findReadyArtifactVersionRecord({
    teamId,
    workspaceId,
    artifactId: created.artifactId,
    artifactVersionId: created.versionId,
  });

  assert.equal(found?.versionId, created.versionId);
  assert.equal(found?.versionNo, 1);
  assert.deepEqual(found?.contentJson, created.payload);
});

test("the exact-version repository refuses a version from another artifact", async () => {
  const first = await createReadyVideo();
  const second = await createReadyVideo();

  assert.equal(
    await findReadyArtifactVersionRecord({
      teamId,
      workspaceId,
      artifactId: first.artifactId,
      artifactVersionId: second.versionId,
    }),
    null,
  );
});

test("the repository hides wrong type, non-ready, and missing current version", async () => {
  const created = await createReadyVideo();
  const query = (
    artifactId: string,
    expectedArtifactType = "video_presentation",
  ) =>
    findCurrentReadyArtifactVersionRecord({
      teamId,
      workspaceId,
      artifactId,
      expectedArtifactType,
    });

  assert.equal(await query(created.artifactId, "report"), null);

  await db
    .update(artifacts)
    .set({ status: "running" })
    .where(eq(artifacts.id, created.artifactId));
  assert.equal(await query(created.artifactId), null);

  const versionlessArtifactId = randomUUID();
  await db.insert(artifacts).values({
    id: versionlessArtifactId,
    teamId,
    workspaceId,
    threadId,
    artifactType: "video_presentation",
    status: "ready",
    currentVersionNo: 1,
    payloadJson: { project: { title: "No version row" } },
    visibility: "workspace",
    createdBy: creatorUserId,
  });
  assert.equal(await query(versionlessArtifactId), null);
});

test("the application reader reapplies live workspace and row visibility", async () => {
  const created = await createReadyVideo({
    payload: { project: { title: "Payload-only video" } },
  });
  const readAs = (userId: string) =>
    readAuthorizedCurrentArtifactVersion({
      workspaceId,
      userId,
      artifactId: created.artifactId,
      expectedArtifactType: "video_presentation",
    });

  const workspaceVisible = await readAs(viewerUserId);
  assert.equal(workspaceVisible?.artifactId, created.artifactId);
  assert.deepEqual(workspaceVisible?.payload, created.payload);

  await db
    .update(artifacts)
    .set({ visibility: "private" })
    .where(eq(artifacts.id, created.artifactId));
  assert.equal(await readAs(viewerUserId), null);
  assert.equal((await readAs(creatorUserId))?.artifactId, created.artifactId);

  // Access is checked for each invocation, so a user removed after turn setup
  // cannot keep reading through the host service.
  await db
    .delete(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, creatorUserId));
  assert.equal(await readAs(creatorUserId), null);
});

test("the republish reader hides private payloads and reapplies revoked access", async () => {
  const created = await createReadyVideo();
  const readAs = (userId: string, selectedWorkspaceId = workspaceId) =>
    readAuthorizedArtifactRecord({
      workspaceId: selectedWorkspaceId,
      userId,
      artifactId: created.artifactId,
    });

  assert.deepEqual((await readAs(viewerUserId))?.payloadJson, created.payload);
  assert.equal(await readAs(randomUUID()), null);
  assert.equal(await readAs(creatorUserId, randomUUID()), null);

  await db
    .update(artifacts)
    .set({ visibility: "private" })
    .where(eq(artifacts.id, created.artifactId));
  assert.equal(await readAs(viewerUserId), null);
  assert.deepEqual((await readAs(creatorUserId))?.payloadJson, created.payload);

  await db
    .delete(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, creatorUserId));
  assert.equal(await readAs(creatorUserId), null);
});
