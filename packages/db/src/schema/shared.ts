import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

/** Renders enum options as a SQL literal list for CHECK constraints. */
export function sqlEnumList(options: readonly string[]) {
  return sql.raw(options.map((value) => `'${value}'`).join(", "));
}

export type PlanFamily =
  | "individual_free"
  | "individual_pro"
  | "team_standard"
  | "team_premium"
  | "enterprise_usage";

export const emptyJsonObject = sql`'{}'::jsonb`;

export const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    if (!value) {
      return [];
    }

    const normalized = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (!normalized) {
      return [];
    }

    return normalized
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((part) => Number.isFinite(part));
  },
});
