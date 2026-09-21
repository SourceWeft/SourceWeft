import { describe, expect, it } from "vitest";

import {
  isSkillMarketAdminUnavailable,
  reviewDecisionBody,
} from "./skill-market-admin";

describe("reviewDecisionBody", () => {
  it("always sends a JSON object, with a reason only when there is one", () => {
    // The publish/reject routes parse a strict JSON body: never `undefined`.
    expect(reviewDecisionBody()).toEqual({});
    expect(reviewDecisionBody("   ")).toEqual({});
    expect(reviewDecisionBody("  Pipes curl into sh  ")).toEqual({
      reason: "Pipes curl into sh",
    });
  });

  it("keeps the reason within the API's limit", () => {
    expect(reviewDecisionBody("x".repeat(1500)).reason).toHaveLength(1000);
  });
});

describe("isSkillMarketAdminUnavailable", () => {
  it("treats not-an-admin and not-a-market-skill as 'no panel'", () => {
    expect(isSkillMarketAdminUnavailable({ status: 403 })).toBe(true);
    expect(isSkillMarketAdminUnavailable({ status: 404 })).toBe(true);
    expect(isSkillMarketAdminUnavailable({ status: 401 })).toBe(true);
  });

  it("does not swallow real failures as expected ones", () => {
    expect(isSkillMarketAdminUnavailable({ status: 500 })).toBe(false);
    expect(isSkillMarketAdminUnavailable(new Error("network"))).toBe(false);
    expect(isSkillMarketAdminUnavailable(null)).toBe(false);
  });
});
