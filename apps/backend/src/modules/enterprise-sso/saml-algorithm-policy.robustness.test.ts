import { expect, test, vi } from "vitest";

// Replace @xmldom/xmldom with a parser that returns a hostile document whose
// `childNodes` getter throws when the walk reads it. This lives in its own file
// because the mock applies to the whole module graph.
vi.mock("@xmldom/xmldom", () => ({
  DOMParser: class {
    parseFromString() {
      return {
        documentElement: {},
        get childNodes(): never {
          throw new Error("hostile childNodes getter");
        },
      };
    }
  },
}));

import { assertSamlResponseAlgorithmsAllowed } from "./saml-algorithm-policy";

test("a hostile parsed document (childNodes getter throws) yields a rejection, never a throw", () => {
  // Valid-looking input so the pre-checks pass and the (mocked) parser runs.
  const input = Buffer.from("<a><b/></a>", "utf8").toString("base64");
  const result = assertSamlResponseAlgorithmsAllowed(input);
  expect(result.ok).toBe(false);
});
