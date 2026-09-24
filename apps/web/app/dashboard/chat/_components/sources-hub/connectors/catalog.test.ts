import { expect, test } from "vitest";
import { connectorCatalog, connectorCatalogCategories } from "./catalog";

test("catalog lists only implemented connectors", () => {
  expect(connectorCatalog.map((item) => item.id)).toEqual(["notion"]);
});

test("every catalog category has at least one connector", () => {
  for (const category of connectorCatalogCategories) {
    expect(connectorCatalog.some((item) => item.category === category)).toBe(
      true,
    );
  }
});
