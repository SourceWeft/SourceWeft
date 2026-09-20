import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ checkout: false }));
vi.mock("./capabilities", () => ({ useCheckoutAvailable: () => state.checkout }));
// The header now embeds the language switcher, which reads Next's app-router
// context. That context does not exist under a bare `renderToStaticMarkup`, so
// stub the hooks the switcher uses.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
}));
import { SourceWeftHeader } from "../../app/_landing/components/sourceweft-header";
import { SourceWeftFooter } from "../../app/_landing/components/sourceweft-footer";
import messages from "../../messages/en.json";
const authState = { isPending: false, isSignedIn: false, user: null };
for (const enabled of [false, true]) {
  test(`public checkout links follow runtime capabilities (${enabled})`, () => {
    state.checkout = enabled;
    for (const Component of [SourceWeftHeader, SourceWeftFooter]) {
      // The chrome is internationalized, so it must render inside the intl
      // provider; the default locale keeps the landing anchors prefix-free.
      // JSON leaves include arrays (feature bullets), looser than next-intl's
      // message type; the runtime handles them via `t.raw`.
      const intlMessages = messages as ComponentProps<
        typeof NextIntlClientProvider
      >["messages"];
      const html = renderToStaticMarkup(
        <NextIntlClientProvider
          locale="en"
          messages={intlMessages}
          timeZone="UTC"
        >
          {createElement(Component, { authState })}
        </NextIntlClientProvider>,
      );
      expect(html.includes('href="/#pricing"')).toBe(enabled);
      expect(html).toContain("SourceWeft");
    }
  });
}
