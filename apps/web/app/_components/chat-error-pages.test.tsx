// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";
import ChatError from "../dashboard/chat/error";
import GlobalError from "../global-error";
import en from "../../messages/en.json";
import zhCN from "../../messages/zh-CN.json";
import zhTW from "../../messages/zh-TW.json";

vi.mock("../dashboard/_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({ workspaceId: null }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}));
vi.mock("next/navigation", () => ({ useParams: () => ({}) }));

it("renders route recovery in each locale and invokes Next retry only on a click", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const retry = vi.fn();
  const error = new Error("private payload");
  try {
    for (const [locale, messages] of Object.entries({
      en,
      "zh-CN": zhCN,
      "zh-TW": zhTW,
    })) {
      await act(async () =>
        root.render(
          <NextIntlClientProvider
            locale={locale}
            messages={messages}
            timeZone="UTC"
            onError={(e) => {
              throw e;
            }}
          >
            <ChatError error={error} retry={retry} />
          </NextIntlClientProvider>,
        ),
      );
      expect(host.textContent).toContain(messages.chatRecovery.title);
      expect(host.textContent).not.toContain("private payload");
    }
    expect(retry).not.toHaveBeenCalled();
    await act(async () => host.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    log.mockRestore();
  }
});

it("renders a complete root recovery document without any providers or raw error text", () => {
  const html = renderToStaticMarkup(
    <GlobalError error={new Error("private payload")} retry={() => {}} />,
  );
  expect(html).toContain('<html lang="en">');
  expect(html).toContain("<body");
  expect(html).toContain("Try again");
  expect(html).not.toContain("private payload");
});
