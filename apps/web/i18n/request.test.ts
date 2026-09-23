import { createTranslator } from "next-intl";
import { expect, test, vi } from "vitest";
import en from "../messages/en.json";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-intl/server", () => ({
  getRequestConfig: (factory: unknown) => factory,
}));
vi.mock("../messages/zh-CN.json", () => ({
  default: { header: { githubRepository: "测试仓库" } },
}));
import config from "./request";

test("a partial translation falls back per key to English, not just per catalog", async () => {
  const result = await config({ requestLocale: Promise.resolve("zh-CN") });
  const messages = result.messages as typeof en;
  expect(messages.header.githubRepository).toBe("测试仓库");
  expect(messages.chatRecovery).toEqual(en.chatRecovery);
  expect(messages.header).toMatchObject({
    ...en.header,
    githubRepository: "测试仓库",
  });
});

test("fallback messages actually render under the selected locale without missing-message errors", async () => {
  const result = await config({ requestLocale: Promise.resolve("zh-CN") });
  const onError = vi.fn();
  const t = createTranslator({
    locale: result.locale!,
    messages: result.messages as typeof en,
    onError,
  });
  expect(t("chatRecovery.title")).toBe(en.chatRecovery.title);
  expect(t("header.githubRepository")).toBe("测试仓库");
  expect(onError).not.toHaveBeenCalled();
});

test("an unsupported locale uses English", async () => {
  const result = await config({
    requestLocale: Promise.resolve("unsupported"),
  });
  expect(result.locale).toBe("en");
  expect(result.messages?.chatRecovery).toEqual(en.chatRecovery);
});
