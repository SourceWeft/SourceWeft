import "dotenv/config";
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/shared/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      "postgres://postgres:postgres@127.0.0.1:5432/sourceweft",
  },
  strict: true,
  verbose: true,
} satisfies Config;
