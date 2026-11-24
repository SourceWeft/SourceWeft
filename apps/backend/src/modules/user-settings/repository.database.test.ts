import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository").userSettingsRepository;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("user_settings");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  const connection = await schema.database.query(
    "select current_database() as name, to_regclass('public.user_settings') as settings",
  );
  expect(connection.rows[0].name).toBe(new URL(isolated.url).pathname.slice(1));
  expect(connection.rows[0].settings).toBe("user_settings");
  repository = (await import("./repository")).userSettingsRepository;
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
    values ($1, 'Settings test', $2, false, now(), now())`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

test("concurrent first inserts preserve both appearance keys", async () => {
  for (let iteration = 0; iteration < 10; iteration++) {
    const userId = await createUser();
    await Promise.all([
      repository.patchAppearance(userId, { appearance: { theme: "dark" } }),
      repository.patchAppearance(userId, { appearance: { language: "zh-CN" } }),
    ]);
    expect(await repository.findByUserId(userId)).toEqual({
      appearance: { theme: "dark", language: "zh-CN" },
    });
  }
});

test("concurrent updates preserve unrelated stored keys, including a legacy preview key", async () => {
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
  await Promise.all([
    repository.patchAppearance(userId, { appearance: { theme: "dark" } }),
    repository.patchAppearance(userId, { appearance: { language: "zh-TW" } }),
  ]);
  expect(await repository.findByUserId(userId)).toEqual({
    appearance: { theme: "dark", language: "zh-TW", density: "compact" },
    preview: { gmail: true },
    unrelated: { value: "retained" },
  });
});
