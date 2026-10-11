import { expect, test } from "vitest";
import { mcpCategoryDefinitions } from "./taxonomy";

test("every MCP category carries its Simplified Chinese name and description", () => {
  for (const category of mcpCategoryDefinitions) {
    expect(category.zhCN?.name, category.slug).toMatch(/\p{Script=Han}/u);
    expect(category.zhCN?.description, category.slug).toMatch(
      /\p{Script=Han}/u,
    );
  }
});
