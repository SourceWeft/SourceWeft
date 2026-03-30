import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, db } from "../shared/database";

async function run() {
  await migrate(db, {
    migrationsFolder: "drizzle",
  });
}

run()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("Drizzle migrations complete");
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Drizzle migrations failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
