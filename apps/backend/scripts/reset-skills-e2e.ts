import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import { Client } from "pg";
const env = parse(await readFile(".env.skills-test"));
if (!new URL(env.DATABASE_URL!).pathname.startsWith("/sourceweft_skillv6_"))
  throw new Error("Refusing non-isolated database");
const client = new Client({ connectionString: env.DATABASE_URL });
try {
  await client.connect();
  await client.query(
    "delete from skill_definitions where source_type = 'registry_github'",
  );
} finally {
  await client.end();
}
