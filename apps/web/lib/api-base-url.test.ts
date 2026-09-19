import { expect, test } from "vitest";
import { followPageHost } from "./api-base-url";

test("a phone or simulator reaches the API on the host that served the page", () => {
  // Otherwise the session cookie is cross-site between sw.localhost and localhost,
  // and WebKit drops it, so sign-in succeeds but no session survives.
  expect(followPageHost("http://localhost:3001", "sw.localhost")).toBe(
    "http://sw.localhost:3001",
  );
  expect(followPageHost("http://127.0.0.1:3001", "192.168.1.20")).toBe(
    "http://192.168.1.20:3001",
  );
});

test("a browser on the configured host is left alone", () => {
  expect(followPageHost("http://localhost:3001", "localhost")).toBe(
    "http://localhost:3001",
  );
});

test("a deployed API origin is never rewritten to the page host", () => {
  expect(followPageHost("https://api.sourceweft.com", "sourceweft.com")).toBe(
    "https://api.sourceweft.com",
  );
});

test("server rendering has no page host and keeps the configured origin", () => {
  expect(followPageHost("http://localhost:3001", undefined)).toBe(
    "http://localhost:3001",
  );
});

test("an unparseable configured origin is passed through untouched", () => {
  expect(followPageHost("not-a-url", "sw.localhost")).toBe("not-a-url");
});
