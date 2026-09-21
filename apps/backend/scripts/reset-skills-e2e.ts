import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import { Client } from "pg";
const env = parse(await readFile(".env.skills-test"));
if (!new URL(env.DATABASE_URL!).pathname.startsWith("/sourceweft_skillv6_"))
  throw new Error("Refusing non-isolated database");
const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
});
try {
  await client.connect();
  // Everything a case can leave behind that changes how the next one behaves.
  // A claim outlives its skills — a later import from a claimed repository
  // belongs to the claimant — so it must go too, or one case's grant decides
  // another's owner.
  for (const statement of [
    "delete from skill_repo_claims",
    "delete from skill_collections",
    "delete from skill_repositories",
    "delete from skill_definitions where source_type = 'registry_github'",
  ]) {
    await client.query(statement);
  }
} finally {
  await client.end();
}
