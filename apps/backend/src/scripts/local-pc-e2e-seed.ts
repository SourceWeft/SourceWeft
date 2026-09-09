import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { auth } from "../modules/auth";
import { onboardingService } from "../modules/onboarding/service";
import { db, workspaces, closeDatabase } from "@sourceweft/db";
import { eq } from "drizzle-orm";
import { createLocalAccountIssuer } from "@better-auth/core/db";

if (
  !new URL(process.env.DATABASE_URL!).pathname.startsWith(
    "/sourceweft_local_pc_e2e_",
  )
)
  throw new Error("Refusing to seed a non-E2E database");
const stateFile = new URL(
  "../../../../output/playwright/local-pc/environment.private.json",
  import.meta.url,
);
const state = JSON.parse(await readFile(stateFile, "utf8"));
if (state.userId) throw new Error("E2E user already exists");
const context = await auth.$context;
const email = "local-pc-e2e@sourceweft.invalid";
const password = "LocalPC-e2e-20260909!";
// Test fixtures use the real password hasher/adapter. No session is injected and
// no verification email is sent; E2E logs in through the ordinary product UI.
const existing = await context.internalAdapter.findUserByEmail(email);
const user =
  existing?.user ??
  (await context.internalAdapter.createUser({
    name: "Local PC E2E",
    email,
    emailVerified: true,
  }));
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
await writeFile(
  stateFile,
  JSON.stringify({
    ...state,
    userId: user.id,
    email,
    password,
    workspaceId: workspace?.id,
  }),
  { mode: 0o600 },
);
console.log(
  "Isolated E2E account and workspace prepared; credentials stored only in the private fixture file.",
);
await closeDatabase();
