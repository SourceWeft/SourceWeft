import { describe, expect, test, vi } from "vitest";
import {
  GitHubUnavailableError,
  fetchGitHubOrgMembership,
  isOrganizationOwner,
} from "./github";

function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.github.com/user/memberships/orgs/acme");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gho_member");
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  });
}

describe("GitHub organization role check", () => {
  test("uses the member's own token and reads the role", async () => {
    const fetch = answering(200, { state: "active", role: "admin" });
    const answer = await fetchGitHubOrgMembership("acme", "gho_member", fetch);
    expect(answer).toEqual({ kind: "member", state: "active", role: "admin" });
    expect(isOrganizationOwner(answer)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a plain member or a pending owner is not an owner", async () => {
    expect(
      isOrganizationOwner(
        await fetchGitHubOrgMembership(
          "acme",
          "gho_member",
          answering(200, { state: "active", role: "member" }),
        ),
      ),
    ).toBe(false);
    expect(
      isOrganizationOwner(
        await fetchGitHubOrgMembership(
          "acme",
          "gho_member",
          answering(200, { state: "pending", role: "admin" }),
        ),
      ),
    ).toBe(false);
  });

  test("403 means the token lacks read:org", async () => {
    await expect(
      fetchGitHubOrgMembership("acme", "gho_member", answering(403, { message: "x" })),
    ).resolves.toEqual({ kind: "scope" });
  });

  test("404 is not a member when the token could have seen it, else a scope gap", async () => {
    await expect(
      fetchGitHubOrgMembership(
        "acme",
        "gho_member",
        answering(404, null, { "x-oauth-scopes": "read:org, read:user" }),
      ),
    ).resolves.toEqual({ kind: "not_member" });
    await expect(
      fetchGitHubOrgMembership(
        "acme",
        "gho_member",
        answering(404, null, { "x-oauth-scopes": "read:user, user:email" }),
      ),
    ).resolves.toEqual({ kind: "scope" });
  });

  test("an unreachable GitHub decides nothing", async () => {
    await expect(
      fetchGitHubOrgMembership("acme", "gho_member", async () => {
        throw new TypeError("fetch failed");
      }),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
    await expect(
      fetchGitHubOrgMembership("acme", "gho_member", answering(500, {})),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });
});
