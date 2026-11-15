import { describe, expect, test } from "vitest";
import { mapSsoRole, validateRoleAttribute } from "./role-mapping";

/**
 * `mapSsoRole` turns an IdP's role attribute into the only two organization
 * roles SSO may assign: `member` or `admin`. It never grants `owner`, and it
 * never splits a value — an attribute is `admin` only when it carries the
 * configured `adminRoleValue` as a whole string (directly or as one element of
 * a string array). Anything else — unconfigured mapping, a non-string/array
 * value, an empty `adminRoleValue` — is `member`.
 */
describe("mapSsoRole", () => {
  const base = { roleAttribute: "groups", adminRoleValue: "sw-admins" };

  test("an array containing the admin value maps to admin", () => {
    expect(
      mapSsoRole({ ...base, userInfo: { groups: ["dev", "sw-admins"] } }),
    ).toBe("admin");
  });

  test("a bare string equal to the admin value maps to admin", () => {
    expect(mapSsoRole({ ...base, userInfo: { groups: "sw-admins" } })).toBe(
      "admin",
    );
  });

  test("an array without the admin value maps to member", () => {
    expect(mapSsoRole({ ...base, userInfo: { groups: ["dev"] } })).toBe(
      "member",
    );
  });

  test("a missing attribute maps to member", () => {
    expect(mapSsoRole({ ...base, userInfo: {} })).toBe("member");
  });

  test("an unconfigured mapping always maps to member", () => {
    expect(
      mapSsoRole({
        userInfo: { groups: ["sw-admins"] },
        roleAttribute: null,
        adminRoleValue: null,
      }),
    ).toBe("member");
  });

  test("a non-string, non-array attribute value maps to member", () => {
    expect(
      mapSsoRole({ ...base, userInfo: { groups: { nested: true } } }),
    ).toBe("member");
  });

  test("a comma-separated string is not split (exact match only)", () => {
    expect(
      mapSsoRole({ ...base, userInfo: { groups: "dev,sw-admins" } }),
    ).toBe("member");
  });

  test("an empty adminRoleValue maps to member", () => {
    expect(
      mapSsoRole({
        roleAttribute: "groups",
        adminRoleValue: "",
        userInfo: { groups: ["sw-admins"] },
      }),
    ).toBe("member");
  });
});

describe("validateRoleAttribute", () => {
  test("accepts a normal claim name and trims it", () => {
    expect(validateRoleAttribute("  groups  ")).toEqual({
      ok: true,
      value: "groups",
    });
  });

  test("rejects a reserved profile-mapping key", () => {
    for (const reserved of ["id", "email", "emailVerified", "name", "image"]) {
      expect(validateRoleAttribute(reserved)).toEqual({
        ok: false,
        reason: "reserved",
      });
    }
  });

  test("rejects an attribute longer than 128 characters", () => {
    expect(validateRoleAttribute("x".repeat(129))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});
