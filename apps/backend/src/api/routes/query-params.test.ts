import { describe, expect, test } from "vitest";
import {
  marketMcpLocaleSchema,
  marketSkillLocaleSchema,
} from "@sourceweft/market-contracts";
import { ApiError } from "../response/api-response";
import { parseLocaleQuery } from "./query-params";

describe("parseLocaleQuery", () => {
  test.each([marketMcpLocaleSchema, marketSkillLocaleSchema])(
    "reads an absent or empty parameter as not given",
    (schema) => {
      expect(parseLocaleQuery(schema, undefined)).toBeUndefined();
      expect(parseLocaleQuery(schema, "")).toBeUndefined();
      // `?locale=%20`, as the public skill routes have always read it.
      expect(parseLocaleQuery(schema, "  ")).toBeUndefined();
    },
  );

  test("passes every supported locale through", () => {
    for (const locale of ["en", "zh-CN", "zh-TW"] as const)
      expect(parseLocaleQuery(marketMcpLocaleSchema, locale)).toBe(locale);
  });

  test("refuses an unsupported locale with a 400 validation error", () => {
    let thrown: unknown;
    try {
      parseLocaleQuery(marketSkillLocaleSchema, "fr");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });
});
