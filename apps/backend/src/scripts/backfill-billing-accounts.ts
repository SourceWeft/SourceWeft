import { billingService } from "../modules/billing";
import { sql } from "drizzle-orm";
import { closeDatabase, db } from "../shared/database";

type OrganizationRow = {
  id: string;
};

async function run() {
  const result = await db.execute<OrganizationRow>(sql`
    select id
    from organization
    order by "createdAt" asc
  `);

  for (const row of result.rows ?? []) {
    await billingService.ensureBillingAccount(row.id);
  }
}

run()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("Billing accounts backfill complete");
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Billing accounts backfill failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
