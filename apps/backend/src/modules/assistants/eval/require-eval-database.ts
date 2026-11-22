// Side-effect import: load the env the way the app does, then stop the
// process before anything else in the evaluation touches the database.
import "dotenv/config";
import { assertEvalDatabaseUrl } from "./guard";

assertEvalDatabaseUrl(process.env.DATABASE_URL);
