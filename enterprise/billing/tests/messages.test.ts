import { expect, test, vi } from "vitest";
vi.mock("../messages/zh-CN.json", () => ({
  default: { controls: { monthly: "按月付费", yearly: "", opening: null } },
}));
import { getBillingControls } from "../src/messages";
test("missing, empty and malformed billing controls fall back individually to English", () => {
  expect(getBillingControls("zh-CN")).toEqual({
    ...getBillingControls("en"),
    monthly: "按月付费",
  });
});
