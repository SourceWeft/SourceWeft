// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SkillClaimPanel } from "./skill-claim-panel";

const api = vi.hoisted(() => ({
  getSkillClaims: vi.fn(),
  removeClaimedRepoFromMarket: vi.fn(),
}));
vi.mock("../../../../lib/skill-claims", () => api);
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: unknown; href: string }) => (
    <a href={href} {...props}>
      {children as never}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;
let container: HTMLDivElement;

const repository = {
  repo: "ada/skills",
  skillCount: 1,
  ownerType: "User",
  claimedBy: null,
  viewerClaim: null,
  accountMethod: { available: true, reason: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<SkillClaimPanel skillId="skill-1" workspaceId="ws-1" />);
  });
}

test("asks about the skill's own repository and links an unclaimed one to the claim page", async () => {
  api.getSkillClaims.mockResolvedValue({ repository });
  await render();
  expect(api.getSkillClaims).toHaveBeenCalledWith("ws-1", { skillId: "skill-1" });
  const link = container.querySelector("a");
  expect(link?.textContent).toBe("Claim this repository");
  expect(link?.getAttribute("href")).toBe(
    "/dashboard/skills/claim?repo=ada%2Fskills",
  );
});

test("says who claimed it, without offering removal to anyone else", async () => {
  api.getSkillClaims.mockResolvedValue({
    repository: { ...repository, claimedBy: "someone" },
  });
  await render();
  expect(container.textContent).toContain("Claimed by the author");
  expect(container.textContent).not.toContain("Remove from SourceWeft");
});

test("offers the verified claimant removal", async () => {
  api.getSkillClaims.mockResolvedValue({
    repository: {
      ...repository,
      claimedBy: "you",
      viewerClaim: {
        id: "claim-1",
        repo: "ada/skills",
        method: "github_account",
        status: "verified",
        createdAt: "2026-09-21T00:00:00.000Z",
        verifiedAt: "2026-09-21T00:00:00.000Z",
      },
    },
  });
  await render();
  expect(container.textContent).toContain("Claimed by you");
  expect(container.textContent).toContain("Remove from SourceWeft");
});

test("renders nothing when the skill has no repository or the request fails", async () => {
  api.getSkillClaims.mockResolvedValue({ repository: null });
  await render();
  expect(container.innerHTML).toBe("");

  api.getSkillClaims.mockRejectedValue(new Error("offline"));
  await act(async () => {
    root.render(<SkillClaimPanel skillId="skill-2" workspaceId="ws-1" />);
  });
  expect(container.innerHTML).toBe("");
});
