import { afterEach, describe, expect, test, vi } from "vitest";
import { ContentError } from "../../content/errors";
import {
  accountMethodAvailability,
  assertAccountOwnsRepo,
  fetchGitHubRepoFacts,
  type GitHubRepoFacts,
} from "./claims";

/**
 * The claim rules without a database: only the repository's owner may claim
 * it, and what GitHub's answers are taken to mean. GitHub is a stubbed
 * `fetch` — the real parsing runs, nothing leaves the machine.
 */

const repo = { owner: "ada", name: "skills" };
const personal: GitHubRepoFacts = {
  fullName: "ada/skills",
  ownerGithubId: "101",
  ownerType: "User",
  defaultBranch: "trunk",
};

async function codeOfAsync(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ContentError);
    return (error as ContentError).code;
  }
}

describe("choosing a method", () => {
  test("the account method needs a linked account on a personal repository it owns", () => {
    expect(
      accountMethodAvailability({
        linkedGithubId: null,
        ownerType: "User",
        ownerGithubId: "101",
      }),
    ).toEqual({ available: false, reason: "not_linked" });
    expect(
      accountMethodAvailability({
        linkedGithubId: "101",
        ownerType: "Organization",
        ownerGithubId: "900",
      }),
    ).toEqual({ available: false, reason: "organization" });
    expect(
      accountMethodAvailability({
        linkedGithubId: "101",
        ownerType: "User",
        ownerGithubId: "202",
      }),
    ).toEqual({ available: false, reason: "not_owner" });
    expect(
      accountMethodAvailability({
        linkedGithubId: "101",
        ownerType: "User",
        ownerGithubId: "101",
      }),
    ).toEqual({ available: true, reason: null });
    // Not looked up yet: worth trying — GitHub decides.
    expect(
      accountMethodAvailability({
        linkedGithubId: "101",
        ownerType: null,
        ownerGithubId: null,
      }),
    ).toEqual({ available: true, reason: null });
  });

  test("only the owner of a personal repository may claim it", () => {
    const refusal = (linkedGithubId: string | null, facts: GitHubRepoFacts) => {
      try {
        assertAccountOwnsRepo({ repo, linkedGithubId, facts });
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(ContentError);
        return error as ContentError;
      }
    };
    const check = (linkedGithubId: string | null, facts: GitHubRepoFacts) =>
      refusal(linkedGithubId, facts)?.code ?? null;
    expect(check("101", personal)).toBeNull();
    // A collaborator — however much they can push — is not the owner.
    expect(refusal("102", personal)).toMatchObject({
      code: "SKILL_CLAIM_ACCOUNT_MISMATCH",
      statusCode: 403,
    });
    expect(check(null, personal)).toBe("SKILL_CLAIM_GITHUB_NOT_LINKED");
    // An organization owns its repository; no member claims it themselves,
    // not even one whose id happened to match. They are told to ask an admin.
    const organization = refusal("101", {
      ...personal,
      ownerType: "Organization",
      ownerGithubId: "101",
    });
    expect(organization).toMatchObject({
      code: "SKILL_CLAIM_ORGANIZATION_REPO",
      statusCode: 409,
    });
    expect(organization?.message).toMatch(/admin/);
    expect(organization?.message).toMatch(/support@sourceweft\.com/);
    // Renamed or transferred: GitHub answered about another repository.
    expect(check("101", { ...personal, fullName: "grace/skills" })).toBe(
      "SKILL_CLAIM_REPO_MOVED",
    );
  });
});

describe("reading GitHub", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGitHub(
    respond: (url: string) => { status: number; body?: unknown },
  ) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const { status, body } = respond(url);
        return new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return calls;
  }

  test("repository facts come from the owner GitHub reports", async () => {
    const calls = stubGitHub(() => ({
      status: 200,
      body: {
        full_name: "Ada/Skills",
        default_branch: "trunk",
        owner: { id: 101, type: "User", login: "Ada" },
      },
    }));
    expect(await fetchGitHubRepoFacts(repo)).toEqual(personal);
    expect(calls).toEqual(["https://api.github.com/repos/ada/skills"]);
  });

  test("an organization's repository says so", async () => {
    stubGitHub(() => ({
      status: 200,
      body: {
        full_name: "acme/skills",
        default_branch: "main",
        owner: { id: 900, type: "Organization" },
      },
    }));
    expect(
      await fetchGitHubRepoFacts({ owner: "acme", name: "skills" }),
    ).toMatchObject({ ownerType: "Organization", ownerGithubId: "900" });
  });

  test("no such repository is null; an answer we cannot read is not a verdict", async () => {
    stubGitHub(() => ({ status: 404, body: { message: "Not Found" } }));
    expect(await fetchGitHubRepoFacts(repo)).toBeNull();

    stubGitHub(() => ({ status: 403, body: { message: "Forbidden" } }));
    expect(await codeOfAsync(() => fetchGitHubRepoFacts(repo))).toBe(
      "SKILL_CLAIM_GITHUB_UNAVAILABLE",
    );

    stubGitHub(() => ({ status: 200, body: { full_name: "ada/skills" } }));
    expect(await codeOfAsync(() => fetchGitHubRepoFacts(repo))).toBe(
      "SKILL_CLAIM_GITHUB_UNAVAILABLE",
    );
  });
});
