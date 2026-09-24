import { expect, test } from "vitest";
import { connectorCatalogForAvailableTypes } from "./catalog";

test("catalog lists only implemented connectors", () => {
  expect(
    connectorCatalogForAvailableTypes(["notion", "gmail"]).map(
      (item) => item.id,
    ),
  ).toEqual(["notion", "gmail"]);
});

test("Gmail stays hidden in the catalog until the backend registers it", () => {
  expect(
    connectorCatalogForAvailableTypes(["notion"]).map((item) => item.id),
  ).toEqual(["notion"]);
});
