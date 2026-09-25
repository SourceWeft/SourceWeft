// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

const audit = vi.hoisted(() => ({ restoreClaimedRepoToMarket: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../../../../../lib/skill-market-audit", async (original) => ({
  ...(await original<typeof import("../../../../../lib/skill-market-audit")>()),
  ...audit,
}));
vi.mock("sonner", () => ({ toast }));

import { RestoreToMarketButton } from "./restore-to-market-button";
import { mountWithIntl, unmountAll } from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

async function render(onRestored = vi.fn()) {
  ({ container } = await mountWithIntl(
    <RestoreToMarketButton
      claimId="claim_1"
      onRestored={onRestored}
      workspaceId="ws_1"
    />,
  ));
  return onRestored;
}

test("restores the caller's claim and tells them what happens next", async () => {
  audit.restoreClaimedRepoToMarket.mockResolvedValue({
    repo: "acme/skills",
    skillCount: 2,
  });
  const onRestored = await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("Restore to SourceWeft");
  await act(async () => button.click());
  expect(audit.restoreClaimedRepoToMarket).toHaveBeenCalledWith(
    "ws_1",
    "claim_1",
  );
  expect(onRestored).toHaveBeenCalledWith({
    repo: "acme/skills",
    skillCount: 2,
  });
  expect(toast.success).toHaveBeenCalledWith(
    expect.stringContaining("2 skills will be listed again"),
  );
});

test("a refusal is shown and nothing is reported as restored", async () => {
  audit.restoreClaimedRepoToMarket.mockRejectedValue(
    new Error("Only a verified claim can restore the repository's skills"),
  );
  const onRestored = await render();
  await act(async () => container.querySelector("button")!.click());
  expect(onRestored).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(
    "Only a verified claim can restore the repository's skills",
  );
  expect(container.querySelector("button")!.disabled).toBe(false);
});
