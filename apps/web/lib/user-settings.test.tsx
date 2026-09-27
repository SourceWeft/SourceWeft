// @vitest-environment jsdom
import { act, createElement } from "react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { mount, unmountAll } from "@/test/react";
import { usePreviewFeature } from "./user-settings";

const state = vi.hoisted(() => ({
  userId: "one" as string | undefined,
  getSettings: vi.fn(),
}));
vi.mock("./auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: state.userId ? { user: { id: state.userId } } : null,
    }),
  },
}));
vi.mock("./sdk", () => ({
  userSettingsClient: { getSettings: state.getSettings },
}));
function Probe() {
  return createElement("span", null, String(usePreviewFeature("gmail")));
}
function response(gmail: boolean) {
  return {
    settings: {
      appearance: { theme: "system", language: "system" },
      preview: { gmail },
    },
  };
}
afterEach(async () => {
  await unmountAll();
  state.userId = "one";
  state.getSettings.mockReset();
  focusManager.setFocused(undefined);
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
test("consumers share one fetch; switching account and signing out deny previous flags", async () => {
  state.getSettings
    .mockResolvedValueOnce(response(true))
    .mockImplementationOnce(() => new Promise(() => {}));
  const client = new QueryClient();
  const tree = () =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(Probe),
      createElement(Probe),
    );
  const view = await mount(tree());
  await settle();
  expect(view.container.textContent).toBe("truetrue");
  expect(state.getSettings).toHaveBeenCalledTimes(1);
  state.userId = "two";
  await view.render(tree());
  expect(view.container.textContent).toBe("falsefalse");
  state.userId = undefined;
  await view.render(tree());
  expect(view.container.textContent).toBe("falsefalse");
  expect(state.getSettings).toHaveBeenCalledTimes(2);
});
test("focus refresh reflects revocation and failed refresh denies stale grants", async () => {
  state.getSettings.mockResolvedValue(response(true));
  const view = await mount(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Probe),
    ),
  );
  await settle();
  expect(view.container.textContent).toBe("true");
  state.getSettings.mockRejectedValue(new Error("offline"));
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle();
  expect(view.container.textContent).toBe("false");
  state.getSettings.mockResolvedValue(response(false));
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle();
  expect(view.container.textContent).toBe("false");
});
test("older payload without preview fails closed", async () => {
  state.getSettings.mockResolvedValue({
    settings: { appearance: { theme: "system", language: "system" } },
  });
  const view = await mount(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Probe),
    ),
  );
  await settle();
  expect(view.container.textContent).toBe("false");
});
