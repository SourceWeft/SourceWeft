import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

// next-intl reads its request config through the Next plugin, which a unit test
// does not have: serve the real English catalog directly instead.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("../../../messages/en.json")).default;
  return {
    getTranslations: async (
      input?: string | { locale?: string; namespace?: string },
    ) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: (typeof input === "string"
          ? input
          : input?.namespace) as never,
      }),
  };
});

import AuthErrorPage from "./page";

async function renderPage(error: string) {
  const element = await AuthErrorPage({
    searchParams: Promise.resolve({ error }),
  });
  return renderToStaticMarkup(element);
}

test("renders the backend seat-limit copy for ?error=SSO_SEAT_LIMIT", async () => {
  const html = await renderPage("SSO_SEAT_LIMIT");
  expect(html).toContain(
    "Your team has no seats left. Ask your administrator to add seats.",
  );
  // The raw code is still surfaced for support.
  expect(html).toContain("SSO_SEAT_LIMIT");
});

test("falls back to the generic description for an unknown error code", async () => {
  const html = await renderPage("NOT_A_REAL_CODE");
  expect(html).toContain(
    "Authentication failed. Please try again, or contact support with the error code below.",
  );
});
