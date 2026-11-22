import { describe, expect, it } from "vitest";
import { assertEvalDatabaseUrl } from "./guard";

describe("assertEvalDatabaseUrl", () => {
  it("accepts a throwaway eval database", () => {
    expect(() =>
      assertEvalDatabaseUrl(
        "postgres://u:p@127.0.0.1:5432/sw_assistant_eval_20261123",
      ),
    ).not.toThrow();
  });

  it("refuses the shared dev database", () => {
    expect(() =>
      assertEvalDatabaseUrl("postgres://u:p@127.0.0.1:5432/sourceweft"),
    ).toThrow(/refusing to run against database "sourceweft"/);
  });

  it("refuses a missing or malformed URL", () => {
    expect(() => assertEvalDatabaseUrl(undefined)).toThrow(/not set/);
    expect(() => assertEvalDatabaseUrl("not a url")).toThrow(/not a valid URL/);
  });
});
