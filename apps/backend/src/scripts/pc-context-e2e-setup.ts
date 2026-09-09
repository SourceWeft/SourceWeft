import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createIsolatedTestDatabase } from "../test/isolated-database";
const root = new URL("../../../../", import.meta.url);
const fixture = new URL(
  "output/playwright/pc-context/environment.private.json",
  root,
);
if (
  process.env.JOB_QUEUE_NAME !== "sourceweft-pc-context-e2e" ||
  process.env.PORT !== "3301"
)
  throw new Error("Use isolated PC context test configuration");
try {
  await readFile(fixture);
  throw new Error("Test environment already exists; reuse it");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const isolated = await createIsolatedTestDatabase("pc_context_e2e");
process.env.DATABASE_URL = isolated.url;
for (const name of ["apps/backend/.env", "apps/web/.env.local"]) {
  const path = new URL(name, root);
  const text = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => !line.startsWith("DATABASE_URL="))
    .join("\n");
  await writeFile(path, `${text}\nDATABASE_URL=${isolated.url}\n`, {
    mode: 0o600,
  });
}
const { auth } = await import("../modules/auth");
const { onboardingService } = await import("../modules/onboarding/service");
const { db, workspaces, closeDatabase } = await import("@sourceweft/db");
const { eq } = await import("drizzle-orm");
const { createLocalAccountIssuer } = await import("@better-auth/core/db");
const context = await auth.$context;
const email = "pc-context-e2e@sourceweft.invalid",
  password = "PC-Context-E2E-2026!";
const user = await context.internalAdapter.createUser({
  name: "PC Context E2E",
  email,
  emailVerified: true,
});
await context.internalAdapter.createAccount({
  userId: user.id,
  accountId: user.id,
  providerId: "credential",
  issuer: createLocalAccountIssuer("credential"),
  password: await context.password.hash(password),
});
await onboardingService.ensurePersonalTeamForUser({ userId: user.id });
const workspace = await db.query.workspaces.findFirst({
  where: eq(workspaces.createdBy, user.id),
});
await mkdir(new URL("output/playwright/pc-context/", root), {
  recursive: true,
});
await writeFile(
  fixture,
  JSON.stringify({
    databaseUrl: isolated.url,
    userId: user.id,
    email,
    password,
    workspaceId: workspace?.id,
  }),
  { mode: 0o600 },
);
await closeDatabase();
console.log(
  "Isolated PC context E2E database/account ready. Credentials remain in private fixture.",
);
