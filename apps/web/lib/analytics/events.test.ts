import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const sent = vi.hoisted(() => ({
  trackEvent: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
}));

vi.mock("./client", () => ({ trackEvent: sent.trackEvent }));

import {
  trackBeginCheckout,
  trackChatMessageSent,
  trackPurchase,
} from "./events";

afterEach(() => {
  sent.trackEvent.mockReset();
});

test("trackBeginCheckout sends GA4 ecommerce fields", () => {
  trackBeginCheckout({ billingInterval: "yearly", plan: "pro", source: "landing" });
  const [name, params] = sent.trackEvent.mock.calls[0]!;
  assert.equal(name, "begin_checkout");
  assert.equal(params?.currency, "USD");
  assert.deepEqual((params?.items as { item_id: string }[])[0]?.item_id, "pro_yearly");
});

test("trackPurchase skips the free plan", () => {
  trackPurchase({
    amountTotal: 0,
    billingInterval: null,
    currency: "usd",
    orderId: "order-1",
    planFamily: "free",
  });
  assert.equal(sent.trackEvent.mock.calls.length, 0);
});

test("trackChatMessageSent maps camelCase to snake_case", () => {
  trackChatMessageSent({
    commandUsed: true,
    hasImages: false,
    hasSources: true,
    skillCount: 2,
    sourceCount: 3,
    surface: "thread",
    toolCount: 1,
  });
  assert.deepEqual(sent.trackEvent.mock.calls[0], [
    "chat_message_sent",
    {
      command_used: true,
      has_images: false,
      has_sources: true,
      skill_count: 2,
      source_count: 3,
      surface: "thread",
      tool_count: 1,
    },
  ]);
});
