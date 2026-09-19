import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ checkout: false }));
vi.mock("./capabilities", () => ({ useCheckoutAvailable: () => state.checkout }));
import { SourceWeftHeader } from "../../app/_landing/components/sourceweft-header";
import { SourceWeftFooter } from "../../app/_landing/components/sourceweft-footer";
const authState = { isPending: false, isSignedIn: false, user: null };
for (const enabled of [false, true]) {
  test(`public checkout links follow runtime capabilities (${enabled})`, () => {
    state.checkout = enabled;
    for (const Component of [SourceWeftHeader, SourceWeftFooter]) {
      const html = renderToStaticMarkup(createElement(Component, { authState }));
      expect(html.includes('href="/#pricing"')).toBe(enabled);
      expect(html).toContain("SourceWeft");
    }
  });
}
