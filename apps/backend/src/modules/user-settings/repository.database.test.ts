import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository").userSettingsRepository;
let access: typeof import("../preview").previewAccessService;
let admin: typeof import("../preview").previewAdminService;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("user_preview");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  const connection = await schema.database.query(
    "select current_database() as name, to_regclass('public.user_settings') as settings",
  );
  expect(connection.rows[0].name).toBe(new URL(isolated.url).pathname.slice(1));
  expect(connection.rows[0].settings).toBe("user_settings");
  repository = (await import("./repository")).userSettingsRepository;
  const preview = await import("../preview");
  access = preview.previewAccessService;
  admin = preview.previewAdminService;
}, 120_000);

afterAll(async () => {
  if (schema) await schema.closeDatabase();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

async function createUser() {
  const userId = randomUUID();
  await schema.database.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    values ($1, 'Preview test', $2, false, now(), now())`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

test("concurrent first inserts preserve both appearance keys and preview", async () => {
  for (let iteration = 0; iteration < 10; iteration++) {
    const userId = await createUser();
    await Promise.all([
      repository.patchAppearance(userId, { appearance: { theme: "dark" } }),
      repository.patchAppearance(userId, { appearance: { language: "zh-CN" } }),
      repository.setPreviewFeature(userId, "gmail", true),
    ]);
    expect(await repository.findByUserId(userId)).toEqual({
      appearance: { theme: "dark", language: "zh-CN" },
      preview: { gmail: true },
    });
  }
});

test("concurrent updates preserve unrelated keys and revocation takes effect immediately", async () => {
  const userId = await createUser();
  await schema.database.query(
    "insert into user_settings (user_id, settings) values ($1, $2)",
    [
      userId,
      JSON.stringify({
        appearance: { theme: "light", language: "en", density: "compact" },
        preview: { gmail: true },
        unrelated: { value: "retained" },
      }),
    ],
  );
  expect(await access.isEnabled(userId, "gmail")).toBe(true);
  await Promise.all([
    repository.patchAppearance(userId, { appearance: { theme: "dark" } }),
    repository.patchAppearance(userId, { appearance: { language: "zh-TW" } }),
    repository.setPreviewFeature(userId, "gmail", false),
  ]);
  expect(await repository.findByUserId(userId)).toEqual({
    appearance: { theme: "dark", language: "zh-TW", density: "compact" },
    preview: { gmail: false },
    unrelated: { value: "retained" },
  });
  await expect(access.requireEnabled(userId, "gmail")).rejects.toMatchObject({
    statusCode: 403,
  });
});

test("operator grants validate real users, dry-run does not insert, repeat grants are idempotent", async () => {
  const userId = randomUUID();
  await schema.database.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    values ($1, 'Preview test', $2, false, now(), now())`,
    [userId, `${userId}@example.test`],
  );
  const input = {
    userId,
    feature: "gmail" as const,
    actor: "test-operator",
    reason: "automated verification",
  };
  await admin.grant({ ...input, dryRun: true });
  expect(await repository.findByUserId(userId)).toBeUndefined();
  expect((await admin.grant(input)).changed).toBe(true);
  expect((await admin.grant(input)).changed).toBe(false);
  expect((await admin.revoke(input)).after).toBe(false);
  await expect(admin.grant({ ...input, userId: randomUUID() })).rejects.toThrow(
    "User not found",
  );
});

test("concurrent grant audit snapshots reflect the serialized mutation order", async () => {
  const userId = await createUser();
  const changes = await Promise.all([
    repository.setPreviewFeature(userId, "gmail", true),
    repository.setPreviewFeature(userId, "gmail", true),
  ]);
  expect(
    changes.filter(
      (change) => Object.keys(change.before as object).length === 0,
    ),
  ).toHaveLength(1);
  expect(
    changes.filter(
      (change) =>
        (change.before as { preview?: { gmail: boolean } }).preview?.gmail ===
        true,
    ),
  ).toHaveLength(1);
});

test("operator refuses malformed stored preview without changing it", async () => {
  for (const preview of [
    "bad",
    { gmail: "true" },
    { gmail: true, unknown: true },
  ]) {
    const userId = await createUser();
    const settings = { preview };
    await schema.database.query(
      "insert into user_settings (user_id, settings) values ($1, $2)",
      [userId, JSON.stringify(settings)],
    );
    await expect(
      repository.setPreviewFeature(userId, "gmail", true),
    ).rejects.toThrow("malformed");
    expect(await repository.findByUserId(userId)).toEqual(settings);
    expect(await access.isEnabled(userId, "gmail")).toBe(false);
  }
});
