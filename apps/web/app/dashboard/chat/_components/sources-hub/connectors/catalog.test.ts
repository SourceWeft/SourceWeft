import { expect, test } from "vitest";
import { connectorCatalogForAvailableTypes } from "./catalog";

test("Gmail stays unavailable in the catalog until the backend registers it", () => {
  const unavailable = connectorCatalogForAvailableTypes(["notion"]).find(
    (item) => item.id === "gmail",
  );
  expect(unavailable?.connectMode).toBe("coming_soon");
  expect(unavailable?.statusKind).toBe("coming_soon");

  const available = connectorCatalogForAvailableTypes(["notion", "gmail"]).find(
    (item) => item.id === "gmail",
  );
  expect(available?.connectMode).toBe("oauth_connector");
  expect(available?.statusKind).toBe("available");
});
