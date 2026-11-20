// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/auth/sign-in",
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("../lib/native-bridge", () => ({
  detectNativeHostKind: () => Promise.resolve("mobile"),
  nativeBridge: { openExternalUrl: vi.fn() },
}));
vi.mock("../lib/native-host", () => ({ usePurchasesAllowed: () => false }));

import { MobileRouteSheetProvider } from "./mobile-route-sheet-provider";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

const loadingIndicator = () =>
  document.querySelector('[data-testid="mobile-route-sheet-loading"]');

test("the sheet says it is loading until its page has loaded", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileRouteSheetProvider>
        <a href="/terms">Terms</a>
      </MobileRouteSheetProvider>,
    ),
  );

  await act(async () => {
    container
      .querySelector("a")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });

  const frame = document.querySelector<HTMLIFrameElement>(
    'iframe[title="Terms"]',
  );
  expect(frame).not.toBeNull();
  expect(loadingIndicator()?.textContent).toContain("loading");

  await act(async () => {
    frame?.dispatchEvent(new Event("load"));
  });
  expect(loadingIndicator()).toBeNull();
});
