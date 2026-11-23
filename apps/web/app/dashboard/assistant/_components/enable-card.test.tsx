// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useAssistantMutations: vi.fn(),
  assistantErrorCode: () => null,
}));
vi.mock("../../../../lib/assistant", () => hooks);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EnableCard } from "./enable-card";
import { buttons, click, mountWithIntl, unmountAll } from "@/test/react";

const enable = vi.fn();

beforeEach(() => {
  enable.mockResolvedValue({ assistant: null });
  hooks.useAssistantMutations.mockReturnValue({
    enable: { mutateAsync: enable, isPending: false },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

test("a member who is not an admin is asked to find one, with no enable button", async () => {
  const { container } = await mountWithIntl(
    <EnableCard workspaceId="ws_1" isAdmin={false} />,
  );
  expect(buttons("Enable assistant", container)).toHaveLength(0);
  expect(container.textContent).toContain(
    "Ask a workspace admin to enable the assistant.",
  );
});

test("an admin can enable the assistant", async () => {
  const { container } = await mountWithIntl(
    <EnableCard workspaceId="ws_1" isAdmin />,
  );
  const [enableButton] = buttons("Enable assistant", container);
  expect(enableButton).toBeDefined();
  await click(enableButton!);
  expect(enable).toHaveBeenCalledTimes(1);
});
