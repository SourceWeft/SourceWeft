import { afterEach, describe, expect, test, vi } from "vitest";
import { ContentError } from "../../content/errors";
import {
  accountMethodAvailability,
  assertAccountOwnsRepo,
  assertClaimFile,
  claimFileMatches,
  createClaimToken,
  fetchClaimFile,
  fetchGitHubRepoFacts,
  hashClaimToken,
  type GitHubRepoFacts,
} from "./claims";

/**
 * The claim rules without a database: tokens, which method may be used, and
 * what GitHub's answers are taken to mean. GitHub is a stubbed `fetch` — the
 * real parsing runs, nothing leaves the machine.
 */

const repo = { owner: "ada", name: "skills" };
const personal: GitHubRepoFacts = {
  fullName: "ada/skills",
  ownerGithubId: "101",
  ownerType: "User",
  defaultBranch: "trunk",
};

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ContentError);
    return (error as ContentError).code;
  }
}

async function codeOfAsync(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ContentError);
    return (error as ContentError).code;
  }
}

describe("claim tokens", () => {
  test("a token is random, and only its hash is needed to check it", () => {
    const first = createClaimToken();
    const second = createClaimToken();
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^sourceweft-claim-[A-Za-z0-9_-]{43}$/);
    expect(first.tokenHash).toBe(hashClaimToken(first.token));
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tokenHash).not.toContain(first.token);
  });

  test("the file matches with surrounding whitespace, and nothing else", () => {
    const { token, tokenHash } = createClaimToken();
    expect(claimFileMatches(token, tokenHash)).toBe(true);
    expect(claimFileMatches(`${token}\n`, tokenHash)).toBe(true);
    expect(claimFileMatches(`  \r\n${token}\r\n\n`, tokenHash)).toBe(true);
    expect(claimFileMatches(`${token}x`, tokenHash)).toBe(false);
    expect(claimFileMatches(`token: ${token}`, tokenHash)).toBe(false);
    expect(claimFileMatches(createClaimToken().token, tokenHash)).toBe(false);
    expect(claimFileMatches("", tokenHash)).toBe(false);
  });

  test("a missing file and a wrong token are told apart", () => {
    const { token, tokenHash } = createClaimToken();
    expect(codeOf(() => assertClaimFile({ fileContent: null, tokenHash }))).toBe(
      "SKILL_CLAIM_FILE_MISSING",
    );
    expect(codeOf(() => assertClaimFile({ fileContent: "nope", tokenHash }))).toBe(
      "SKILL_CLAIM_FILE_MISMATCH",
    );
    expect(
      codeOf(() => assertClaimFile({ fileContent: token, tokenHash: null })),
    ).toBe("SKILL_CLAIM_FILE_MISMATCH");
    expect(
      codeOf(() => assertClaimFile({ fileContent: ` ${token}\n`, tokenHash })),
    ).toBeNull();
  });
});

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

  test("GitHub's live answer decides the account method", () => {
    const check = (linkedGithubId: string | null, facts: GitHubRepoFacts) =>
      codeOf(() => assertAccountOwnsRepo({ repo, linkedGithubId, facts }));
    expect(check("101", personal)).toBeNull();
    expect(check("102", personal)).toBe("SKILL_CLAIM_ACCOUNT_MISMATCH");
    expect(check(null, personal)).toBe("SKILL_CLAIM_GITHUB_NOT_LINKED");
    // An organization member is not the repository's author.
    expect(
      check("101", { ...personal, ownerType: "Organization", ownerGithubId: "101" }),
    ).toBe("SKILL_CLAIM_ORGANIZATION_REPO");
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

  test("the claim file is read from the named branch and decoded", async () => {
    const { token, tokenHash } = createClaimToken();
    const calls = stubGitHub(() => ({
      status: 200,
      body: {
        type: "file",
        encoding: "base64",
        size: token.length + 1,
        content: Buffer.from(`${token}\n`).toString("base64"),
      },
    }));
    const content = await fetchClaimFile(repo, "release/v2");
    expect(calls).toEqual([
      "https://api.github.com/repos/ada/skills/contents/.sourceweft/claim?ref=release%2Fv2",
    ]);
    expect(content).toBe(`${token}\n`);
    expect(codeOf(() => assertClaimFile({ fileContent: content, tokenHash }))).toBeNull();
  });

  test("a missing claim file, or a directory in its place, is not there", async () => {
    stubGitHub(() => ({ status: 404, body: { message: "Not Found" } }));
    expect(await fetchClaimFile(repo, "main")).toBeNull();

    stubGitHub(() => ({ status: 200, body: [{ type: "file", name: "x" }] }));
    expect(await fetchClaimFile(repo, "main")).toBeNull();
  });

  test("a claim file with other content does not match", async () => {
    const { tokenHash } = createClaimToken();
    stubGitHub(() => ({
      status: 200,
      body: {
        type: "file",
        encoding: "base64",
        size: 20,
        content: Buffer.from("someone-elses-token\n").toString("base64"),
      },
    }));
    const content = await fetchClaimFile(repo, "main");
    expect(codeOf(() => assertClaimFile({ fileContent: content, tokenHash }))).toBe(
      "SKILL_CLAIM_FILE_MISMATCH",
    );
  });

  test("an oversized file is present but can never match", async () => {
    stubGitHub(() => ({
      status: 200,
      body: { type: "file", encoding: "base64", size: 1_000_000, content: "" },
    }));
    const content = await fetchClaimFile(repo, "main");
    expect(content).toBe("");
    expect(
      codeOf(() =>
        assertClaimFile({ fileContent: content, tokenHash: hashClaimToken("x") }),
      ),
    ).toBe("SKILL_CLAIM_FILE_MISMATCH");
  });
});
