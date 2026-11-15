import { describe, expect, test } from "vitest";
import { mapSsoRole, SSO_ROLE_CLAIM_KEY, validateRoleAttribute } from "./role-mapping";

/**
 * `mapSsoRole` turns the IdP's role claim — which the guard maps into the fixed
 * {@link SSO_ROLE_CLAIM_KEY} on `userInfo`, never the tenant's attribute name —
 * into the only two organization roles SSO may assign: `member` or `admin`. It
 * never grants `owner`, and never splits a value: `admin` only when the claim
 * carries the configured `adminRoleValue` as a whole string (directly or as one
 * element of a string array). Anything else is `member`.
 */
describe("mapSsoRole", () => {
  const base = { roleManaged: true, adminRoleValue: "sw-admins" };
  const claim = (value: unknown) => ({ [SSO_ROLE_CLAIM_KEY]: value });

  test("an array containing the admin value maps to admin", () => {
    expect(mapSsoRole({ ...base, userInfo: claim(["dev", "sw-admins"]) })).toBe(
      "admin",
    );
  });

  test("a bare string equal to the admin value maps to admin", () => {
    expect(mapSsoRole({ ...base, userInfo: claim("sw-admins") })).toBe("admin");
  });

  test("an array without the admin value maps to member", () => {
    expect(mapSsoRole({ ...base, userInfo: claim(["dev"]) })).toBe("member");
  });

  test("a missing claim maps to member", () => {
    expect(mapSsoRole({ ...base, userInfo: {} })).toBe("member");
  });

  test("an unmanaged provider always maps to member", () => {
    expect(
      mapSsoRole({
        userInfo: claim(["sw-admins"]),
        roleManaged: false,
        adminRoleValue: null,
      }),
    ).toBe("member");
  });

  test("a non-string, non-array claim value maps to member", () => {
    expect(mapSsoRole({ ...base, userInfo: claim({ nested: true }) })).toBe(
      "member",
    );
  });

  test("a comma-separated string is not split (exact match only)", () => {
    expect(mapSsoRole({ ...base, userInfo: claim("dev,sw-admins") })).toBe(
      "member",
    );
  });

  test("an empty adminRoleValue maps to member", () => {
    expect(
      mapSsoRole({
        roleManaged: true,
        adminRoleValue: "",
        userInfo: claim(["sw-admins"]),
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

  test("accepts names that are user columns (they map into a namespaced key)", () => {
    for (const name of ["id", "email", "emailVerified", "name", "image", "role"]) {
      expect(validateRoleAttribute(name)).toEqual({ ok: true, value: name });
    }
  });

  test("rejects an attribute longer than 128 characters", () => {
    expect(validateRoleAttribute("x".repeat(129))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  test("rejects an attribute containing control characters", () => {
    expect(validateRoleAttribute("groups\u0000")).toEqual({
      ok: false,
      reason: "control_characters",
    });
  });
});
