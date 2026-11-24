import { afterEach, beforeEach, expect, test, vi } from "vitest";

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}));
vi.mock("../../../lib/internal-api-base-url", () => ({
  internalApiBaseUrl: () => "https://api.test",
}));
// The view itself is covered by shared-chat-view.test.tsx; this file only
// checks the server-side fetch the page makes.
vi.mock("./shared-chat-view", () => ({
  SharedChatView: () => null,
  SharedChatUnavailable: () => null,
}));

import SharedChatPage, { generateMetadata } from "./page";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ chat: null }), { status: 404 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  requestHeaders.current = new Headers();
});

function forwardedHeadersOfCall(index = 0): Headers {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

test("the page forwards the visitor's client-IP headers on its internal share fetch", async () => {
  requestHeaders.current = new Headers({
    "cf-connecting-ip": "203.0.113.7",
    "x-real-ip": "203.0.113.8",
    "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    cookie: "session=secret",
    authorization: "Bearer secret",
  });

  await SharedChatPage({ params: Promise.resolve({ token: "tok-1" }) });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "https://api.test/v1/public/shares/tok-1/chat",
  );
  const forwarded = forwardedHeadersOfCall();
  expect(forwarded.get("cf-connecting-ip")).toBe("203.0.113.7");
  expect(forwarded.get("x-real-ip")).toBe("203.0.113.8");
  expect(forwarded.get("x-forwarded-for")).toBe("203.0.113.9, 10.0.0.1");
  // Only the three client-IP headers are forwarded, never credentials.
  expect(forwarded.get("cookie")).toBeNull();
  expect(forwarded.get("authorization")).toBeNull();
});

test("generateMetadata forwards the same client-IP headers", async () => {
  requestHeaders.current = new Headers({ "x-real-ip": "198.51.100.4" });

  await generateMetadata({ params: Promise.resolve({ token: "tok-2" }) });

  const forwarded = forwardedHeadersOfCall();
  expect(forwarded.get("x-real-ip")).toBe("198.51.100.4");
});

test("absent client-IP headers are not sent", async () => {
  requestHeaders.current = new Headers({ "x-real-ip": "198.51.100.4" });

  await SharedChatPage({ params: Promise.resolve({ token: "tok-3" }) });

  const forwarded = forwardedHeadersOfCall();
  expect(forwarded.has("cf-connecting-ip")).toBe(false);
  expect(forwarded.has("x-forwarded-for")).toBe(false);
  expect(forwarded.get("x-real-ip")).toBe("198.51.100.4");
});
