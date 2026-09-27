import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ checkout: false }));
vi.mock("./capabilities", () => ({
  useCheckoutAvailable: () => state.checkout,
}));
// The header now embeds the language switcher, which reads Next's app-router
// context. That context does not exist under a bare `renderToStaticMarkup`, so
// stub the hooks the switcher uses.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
}));
import { SourceWeftHeader } from "../../app/_landing/components/sourceweft-header";
import { SourceWeftFooter } from "../../app/_landing/components/sourceweft-footer";
import { withIntl } from "@/test/react";
const authState = { isPending: false, isSignedIn: false, user: null };
for (const enabled of [false, true]) {
  test(`public checkout links follow runtime capabilities (${enabled})`, () => {
    state.checkout = enabled;
    for (const Component of [SourceWeftHeader, SourceWeftFooter]) {
      // Match the app's providers: the language switcher uses shared settings.
      // The default locale keeps the landing anchors prefix-free.
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          withIntl(createElement(Component, { authState }), { timeZone: "UTC" }),
        ),
      );
      expect(html.includes('href="/#pricing"')).toBe(enabled);
      expect(html).toContain("SourceWeft");
    }
  });
}
