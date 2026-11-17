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

const FALLBACK =
  "Authentication failed. Please try again, or contact support with the error code below.";

// Every code the SSO resolver / guard can redirect to the error page with must
// have its own entry — none should fall through to the generic description.
const SSO_REDIRECT_CODES = [
  "SSO_ACCOUNT_LINK_DENIED",
  "SSO_SEAT_LIMIT",
  "SSO_PROVISIONING_FAILED",
  "SSO_DOMAIN_NOT_VERIFIED",
  "SSO_PROVIDER_NOT_FOUND",
  "SSO_ORGANIZATION_REQUIRED",
  "SSO_SAML_ALGORITHM_NOT_ALLOWED",
];

for (const code of SSO_REDIRECT_CODES) {
  test(`every SSO redirect code has its own entry: ${code}`, async () => {
    const html = await renderPage(code);
    expect(html).not.toContain(FALLBACK);
    // The raw code is still surfaced for support.
    expect(html).toContain(code);
  });
}

test("renders the backend seat-limit copy for ?error=SSO_SEAT_LIMIT", async () => {
  const html = await renderPage("SSO_SEAT_LIMIT");
  expect(html).toContain(
    "Your team has no seats left. Ask your administrator to add seats.",
  );
});

test("uses member-facing copy for SSO_ORGANIZATION_REQUIRED, not the backend setup wording", async () => {
  const html = await renderPage("SSO_ORGANIZATION_REQUIRED");
  // Apostrophes render as HTML entities in static markup, so assert on the
  // apostrophe-free remainder.
  expect(html).toContain(
    "available for this team right now. Contact your administrator.",
  );
  // Not the backend's setup-oriented message.
  expect(html).not.toContain("can only be set up for a team");
});

test("renders the SAML algorithm copy for ?error=SSO_SAML_ALGORITHM_NOT_ALLOWED", async () => {
  const html = await renderPage("SSO_SAML_ALGORITHM_NOT_ALLOWED");
  // Apostrophes render as HTML entities in static markup, so assert on the
  // apostrophe-free remainder of the sentence.
  expect(html).toContain(
    "Ask your administrator to sign with SHA-256 and to send unencrypted assertions.",
  );
  expect(html).toContain("SSO_SAML_ALGORITHM_NOT_ALLOWED");
});

test("falls back to the generic description for an unknown error code", async () => {
  const html = await renderPage("NOT_A_REAL_CODE");
  expect(html).toContain(
    "Authentication failed. Please try again, or contact support with the error code below.",
  );
});
