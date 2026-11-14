// @vitest-environment jsdom

import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  host: { kind: "mobile", platform: "ios" } as
    { kind: "web" } | { kind: "mobile"; platform: string | null },
  signOut: vi.fn(),
}));

vi.mock("../../../lib/auth-client", () => ({
  authClient: { signOut: state.signOut },
}));

vi.mock("../../../lib/native-host", async (original) => ({
  ...(await original<typeof import("../../../lib/native-host")>()),
  useNativeHost: () => state.host,
}));

import { aiDataConsentKey } from "../../../lib/ai-data-consent";
import { AiDataConsentGate } from "./ai-data-consent-gate";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

const dashboard = () => document.querySelector("[data-testid=dashboard]");
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );

function gate(userId: string | undefined) {
  return (
    <AiDataConsentGate userId={userId}>
      <div data-testid="dashboard">dashboard</div>
    </AiDataConsentGate>
  );
}

beforeEach(() => {
  state.host = { kind: "mobile", platform: "ios" };
  state.signOut.mockReset();
  state.signOut.mockResolvedValue({});
  window.localStorage.clear();
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

test("the iOS app shows the disclosure and mounts nothing behind it until the person agrees", async () => {
  await mountWithIntl(gate("user-1"));

  assert.equal(dashboard(), null);
  const text = document.body.textContent ?? "";
  assert.match(text, /third-party AI model providers/);
  assert.match(text, /Privacy Policy/);

  button("Agree and continue")!.click();
  await flush();

  assert(dashboard(), "the dashboard is shown after agreeing");
  assert(window.localStorage.getItem(aiDataConsentKey("user-1")));
});

test("an account that already agreed on this device is not asked again, another account is", async () => {
  window.localStorage.setItem(aiDataConsentKey("user-1"), "2026-11-14");

  await mountWithIntl(gate("user-1"));
  assert(dashboard());
  await unmountAll();

  await mountWithIntl(gate("user-2"));
  assert.equal(dashboard(), null);
});

test("declining signs the person out and never shows the dashboard", async () => {
  await mountWithIntl(gate("user-1"));

  button("Decline and sign out")!.click();
  await flush();

  assert.equal(state.signOut.mock.calls.length, 1);
  assert.equal(dashboard(), null);
  assert.equal(window.localStorage.getItem(aiDataConsentKey("user-1")), null);
});

test("agreeing still lets the person in for this visit when the device cannot store it", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  await mountWithIntl(gate("user-1"));

  button("Agree and continue")!.click();
  await flush();

  assert(dashboard());
});

test("the privacy policy opens outside the app", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await mountWithIntl(gate("user-1"));

  button("Privacy Policy")!.click();

  assert.deepEqual(open.mock.calls[0]?.slice(0, 2), [
    `${window.location.origin}/privacy`,
    "_blank",
  ]);
});

test("nobody is asked on the web, on Android, or before an account is known", async () => {
  for (const host of [
    { kind: "web" },
    { kind: "mobile", platform: "android" },
    { kind: "mobile", platform: null },
  ] as const) {
    state.host = host;
    await mountWithIntl(gate("user-1"));
    assert(dashboard(), JSON.stringify(host));
    await unmountAll();
  }

  state.host = { kind: "mobile", platform: "ios" };
  await mountWithIntl(gate(undefined));
  assert(dashboard());
});
