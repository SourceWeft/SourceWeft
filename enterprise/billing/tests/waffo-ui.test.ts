// @vitest-environment jsdom
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import {
  BillingUiProvider,
  useBillingUiHost,
  type BillingUiHost,
} from "../src/ui/context";

test("Waffo checkout waits for a user click, opens a protected new tab and preserves the merchant page", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const originalUrl = window.location.href;
  const host = {} as BillingUiHost;
  function Merchant() {
    const { openCheckout } = useBillingUiHost();
    return h(
      "div",
      null,
      h("input", { id: "merchant-draft", defaultValue: "draft stays here" }),
      h(
        "button",
        {
          id: "prepare-checkout",
          onClick: () =>
            openCheckout({
              provider: "waffo",
              checkoutUrl: "https://pancake.waffo.ai/checkout/cs_test",
              grantedCredits: 10000,
            }),
        },
        "Prepare",
      ),
    );
  }
  try {
    await act(async () => {
      root.render(h(BillingUiProvider, { value: host, children: h(Merchant) }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>("#prepare-checkout")!.click();
    });
    assert.equal(open.mock.calls.length, 0);
    assert.match(
      document.querySelector('[role="dialog"]')!.textContent!,
      /10,000 credits/,
    );
    const button = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open checkout",
    )!;
    await act(async () => {
      button.click();
    });
    assert.deepEqual(open.mock.calls[0], [
      "https://pancake.waffo.ai/checkout/cs_test",
      "_blank",
      "noopener,noreferrer",
    ]);
    assert.equal(window.location.href, originalUrl);
    assert.equal(
      document.querySelector<HTMLInputElement>("#merchant-draft")!.value,
      "draft stays here",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    open.mockRestore();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  }
});
