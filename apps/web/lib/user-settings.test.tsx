// @vitest-environment jsdom
import { act, createElement } from "react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { mount, unmountAll } from "@/test/react";
import { useUserSettings } from "./user-settings";

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
  const { data } = useUserSettings();
  return createElement("span", null, data?.settings.appearance.theme ?? "none");
}
function response(theme: "light" | "dark") {
  return { settings: { appearance: { theme, language: "system" } } };
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
test("consumers share one fetch; switching account and signing out drop the previous account's settings", async () => {
  state.getSettings
    .mockResolvedValueOnce(response("dark"))
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
  expect(view.container.textContent).toBe("darkdark");
  expect(state.getSettings).toHaveBeenCalledTimes(1);
  state.userId = "two";
  await view.render(tree());
  expect(view.container.textContent).toBe("nonenone");
  state.userId = undefined;
  await view.render(tree());
  expect(view.container.textContent).toBe("nonenone");
  expect(state.getSettings).toHaveBeenCalledTimes(2);
});
test("focus refresh picks up settings changed elsewhere", async () => {
  state.getSettings.mockResolvedValue(response("dark"));
  const view = await mount(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Probe),
    ),
  );
  await settle();
  expect(view.container.textContent).toBe("dark");
  state.getSettings.mockResolvedValue(response("light"));
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle();
  expect(view.container.textContent).toBe("light");
});
