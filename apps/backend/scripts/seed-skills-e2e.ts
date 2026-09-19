import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse } from "dotenv";
const envPath = ".env.skills-test";
const text = await readFile(envPath, "utf8");
const env = parse(text);
if (!new URL(env.DATABASE_URL!).pathname.startsWith("/sourceweft_skillv6_"))
  throw new Error("Refusing non-isolated database");
const api = env.NEXT_PUBLIC_API_BASE_URL!,
  web = env.NEXT_PUBLIC_WEB_BASE_URL!;
const accounts: Record<
  string,
  { email: string; password: string; id: string }
> = {};
for (const role of ["owner", "other", "admin"]) {
  const email = `skill-e2e-${role}-${randomUUID()}@example.test`,
    password = `S1-${randomUUID()}!`;
  const response = await fetch(`${api}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: web },
    body: JSON.stringify({ name: `Skill E2E ${role}`, email, password }),
  });
  if (!response.ok)
    throw new Error(
      `Could not create ${role} test account: HTTP ${response.status}`,
    );
  const body = (await response.json()) as { user: { id: string } };
  accounts[role] = { email, password, id: body.user.id };
}
await writeFile(".skills-e2e-accounts.json", JSON.stringify(accounts), {
  mode: 0o600,
});
await writeFile(
  envPath,
  text.replace(
    /^MARKET_ADMIN_USER_IDS=.*$/m,
    `MARKET_ADMIN_USER_IDS="skill-test-admin,${accounts.admin!.id}"`,
  ),
  { mode: 0o600 },
);
console.log(
  "Created reusable E2E accounts. Restart the isolated API to load its test admin allowlist.",
);
