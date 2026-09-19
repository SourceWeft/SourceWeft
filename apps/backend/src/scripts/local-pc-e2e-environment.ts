import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createIsolatedTestDatabase } from "../test/isolated-database";

const root = new URL("../../../../", import.meta.url);
const statePath = new URL(
  "output/playwright/local-pc/environment.private.json",
  root,
);
try {
  await readFile(statePath);
  throw new Error("An isolated E2E environment already exists; reuse it.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (
  process.env.BACKEND_API_PORT !== "3101" ||
  process.env.JOB_QUEUE_NAME !== "sourceweft-local-pc-e2e"
)
  throw new Error("Expected isolated E2E ports and queue");
const isolated = await createIsolatedTestDatabase("local_pc_e2e");
await mkdir(new URL("output/playwright/local-pc/", root), { recursive: true });
await writeFile(statePath, JSON.stringify({ databaseUrl: isolated.url }), {
  mode: 0o600,
});
for (const relative of ["apps/backend/.env", "apps/web/.env.local"]) {
  const target = new URL(relative, root);
  const content = (await readFile(target, "utf8"))
    .split("\n")
    .filter((line) => !line.startsWith("DATABASE_URL="))
    .join("\n");
  await writeFile(target, `${content}\nDATABASE_URL=${isolated.url}\n`, {
    mode: 0o600,
  });
}
console.log(
  "Independent local-PC E2E database migrated. Private worktree env updated; no production data copied.",
);
