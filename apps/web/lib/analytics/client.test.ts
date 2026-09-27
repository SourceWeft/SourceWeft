import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import type { AnalyticsValue } from "./catalog";
import { createAnalyticsClient } from "./client";
import type { AnalyticsContext } from "./context";
import type { AnalyticsDestination, DestinationId } from "./destinations/types";

type Call =
  | { op: "context"; ctx: AnalyticsContext }
  | { op: "track"; name: string; params: Record<string, AnalyticsValue> };

function fakeDestination(
  id: DestinationId,
  options: { ready?: boolean; requiresConsent?: boolean } = {},
) {
  const calls: Call[] = [];
  const state = { ready: options.ready ?? true };
  const destination: AnalyticsDestination = {
    id,
    requiresConsent: options.requiresConsent ?? false,
    isReady: () => state.ready,
    setContext: (ctx) => calls.push({ op: "context", ctx }),
    track: (name, params) => calls.push({ op: "track", name, params }),
  };
  return { destination, calls, state };
}

function deferredContext() {
  let resolve!: (ctx: AnalyticsContext) => void;
  const promise = new Promise<AnalyticsContext>((r) => {
    resolve = r;
  });
  return { resolveContext: () => promise, resolve };
}

const web = () => Promise.resolve<AnalyticsContext>({ platform: "web" });
const flush = () => new Promise((r) => setTimeout(r, 0));
const tracks = (calls: Call[]) => calls.filter((c) => c.op === "track");

afterEach(() => {
  vi.restoreAllMocks();
});

test("no destinations: track is a no-op", async () => {
  const client = createAnalyticsClient({
    destinations: [],
    resolveContext: web,
    strict: true,
  });
  client.track("login", { method: "email" });
  await flush();
});

test("queues until context resolves, then delivers with platform merged", async () => {
  const gtm = fakeDestination("gtm");
  const ctx = deferredContext();
  const client = createAnalyticsClient({
    destinations: [gtm.destination],
    resolveContext: ctx.resolveContext,
    strict: true,
  });
  client.track("login", { method: "email" });
  await flush();
  assert.equal(gtm.calls.length, 0);

  ctx.resolve({ platform: "desktop_app", app_version: "1.4.0" });
  await flush();
  assert.deepEqual(tracks(gtm.calls), [
    {
      op: "track",
      name: "login",
      params: { method: "email", platform: "desktop_app", app_version: "1.4.0" },
    },
  ]);
});

test("setContext is delivered before the first event", async () => {
  const gtm = fakeDestination("gtm");
  const client = createAnalyticsClient({
    destinations: [gtm.destination],
    resolveContext: web,
    strict: true,
  });
  client.track("login", { method: "email" });
  await flush();
  assert.deepEqual(
    gtm.calls.map((c) => c.op),
    ["context", "track"],
  );
});

test("a not-ready destination waits for notifyReady while a ready one delivers", async () => {
  const gtm = fakeDestination("gtm");
  const umami = fakeDestination("umami", { ready: false });
  const client = createAnalyticsClient({
    destinations: [gtm.destination, umami.destination],
    resolveContext: web,
    strict: true,
  });
  client.track("login", { method: "email" });
  await flush();
  assert.equal(tracks(gtm.calls).length, 1);
  assert.equal(umami.calls.length, 0);

  umami.state.ready = true;
  client.notifyReady("umami");
  assert.deepEqual(
    umami.calls.map((c) => c.op),
    ["context", "track"],
  );
});

test("strict mode throws on an invalid event", () => {
  const client = createAnalyticsClient({
    destinations: [fakeDestination("gtm").destination],
    resolveContext: web,
    strict: true,
  });
  assert.throws(() => client.track("login", { email: "a@b.c" }), /email/);
});

test("lenient mode drops and warns", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const gtm = fakeDestination("gtm");
  const client = createAnalyticsClient({
    destinations: [gtm.destination],
    resolveContext: web,
    strict: false,
  });
  client.track("login", { email: "a@b.c" });
  await flush();
  assert.equal(tracks(gtm.calls).length, 0);
  assert.equal(warn.mock.calls.length, 1);
});

test("undefined params are removed", async () => {
  const gtm = fakeDestination("gtm");
  const client = createAnalyticsClient({
    destinations: [gtm.destination],
    resolveContext: web,
    strict: true,
  });
  client.track("checkout_error", { plan: "pro", source: undefined });
  await flush();
  assert.deepEqual(tracks(gtm.calls)[0], {
    op: "track",
    name: "checkout_error",
    params: { plan: "pro", platform: "web" },
  });
});

test("queue keeps the newest 100 events", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const umami = fakeDestination("umami", { ready: false });
  const client = createAnalyticsClient({
    destinations: [umami.destination],
    resolveContext: web,
    strict: true,
  });
  for (let i = 0; i < 101; i += 1) {
    client.track("skill_selected", { skill_count: i });
  }
  await flush();
  umami.state.ready = true;
  client.notifyReady("umami");

  const delivered = tracks(umami.calls);
  assert.equal(delivered.length, 100);
  assert.equal(
    delivered[0]?.op === "track" && delivered[0].params.skill_count,
    1,
  );
  assert.ok(warn.mock.calls.length >= 1);
});

test("consent gate skips consent-requiring destinations", async () => {
  const gated = fakeDestination("gtm", { requiresConsent: true });
  const open = fakeDestination("umami");
  const client = createAnalyticsClient({
    destinations: [gated.destination, open.destination],
    resolveContext: web,
    strict: true,
    consent: () => ({ analytics: false }),
  });
  client.track("login", { method: "email" });
  await flush();
  assert.equal(gated.calls.length, 0);
  assert.equal(tracks(open.calls).length, 1);
});

test("events delivered in order", async () => {
  const gtm = fakeDestination("gtm");
  const client = createAnalyticsClient({
    destinations: [gtm.destination],
    resolveContext: web,
    strict: true,
  });
  client.track("login", { method: "email" });
  client.track("skill_selected", { skill_count: 2 });
  await flush();
  client.track("artifact_shared", {});
  assert.deepEqual(
    tracks(gtm.calls).map((c) => c.op === "track" && c.name),
    ["login", "skill_selected", "artifact_shared"],
  );
});
