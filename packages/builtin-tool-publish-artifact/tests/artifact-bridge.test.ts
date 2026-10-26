import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  ArtifactRecordTransportError,
  type ArtifactRecordsTransport,
} from "@sourceweft/contracts/artifact-records";
import {
  ArtifactBridgeHost,
  artifactRuntimeUrl,
} from "../src/ui/artifact-bridge";

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

function setup(
  initial: ArtifactRecordsTransport | null = { execute: vi.fn() },
) {
  let transport = initial;
  const frame = { postMessage: vi.fn() } as unknown as Window;
  const onOpenLink = vi.fn();
  let now = 0;
  const bridge = new ArtifactBridgeHost({
    frameWindow: () => frame,
    transport: () => transport,
    onOpenLink,
    requestsPerSecond: 3,
    now: () => now,
  });
  const send = (
    data: unknown,
    overrides: Partial<{ source: unknown; origin: string }> = {},
  ) =>
    bridge.handleMessage({
      data,
      source: frame,
      origin: "null",
      ...overrides,
    } as MessageEvent);
  const connect = () => {
    send({ type: "sourceweft.storage/hello", v: 1 });
    const call = (frame.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    );
    assert.ok(call, "expected a welcome");
    assert.deepEqual(call[0], { type: "sourceweft.storage/welcome", v: 1 });
    assert.equal(call[1], "*");
    const port = call[2][0] as MessagePort;
    ports.push(port);
    const replies: unknown[] = [];
    port.onmessage = (event) => replies.push(event.data);
    const request = async (data: unknown) => {
      const before = replies.length;
      port.postMessage(data);
      await vi.waitFor(() => assert.ok(replies.length > before));
      return replies.at(-1);
    };
    return { request, port };
  };
  return {
    bridge,
    frame,
    send,
    connect,
    onOpenLink,
    swapTransport: (next: ArtifactRecordsTransport | null) =>
      (transport = next),
    tick: (ms: number) => (now += ms),
  };
}

test("only the iframe's own opaque-origin document may connect", () => {
  const { send, frame } = setup();
  send({ type: "sourceweft.storage/hello", v: 1 }, { source: {} });
  send(
    { type: "sourceweft.storage/hello", v: 1 },
    { origin: "https://evil.example" },
  );
  send({ type: "sourceweft.storage/hello", v: 2 });
  assert.equal(
    (frame.postMessage as ReturnType<typeof vi.fn>).mock.calls.length,
    0,
  );
});

test("requests are forwarded without anything the page could use to retarget them", async () => {
  const execute = vi.fn().mockResolvedValue({ op: "get", record: null });
  const { connect } = setup({ execute });
  const { request } = connect();
  assert.deepEqual(
    await request({
      requestId: 1,
      operation: { op: "get", collection: "kv", id: "a" },
    }),
    { requestId: 1, ok: true, result: { op: "get", record: null } },
  );
  assert.deepEqual(execute.mock.calls[0]![0], {
    op: "get",
    scope: "user",
    collection: "kv",
    id: "a",
  });
  const smuggled = await request({
    requestId: 2,
    artifactId: "other",
    operation: { op: "get", collection: "kv", id: "a" },
  });
  assert.deepEqual(smuggled, {
    requestId: 2,
    ok: false,
    error: {
      code: "invalid_request",
      message: "The storage request is not valid",
    },
  });
  assert.equal(execute.mock.calls.length, 1);
});

test("transport errors reach the page as their short codes", async () => {
  const execute = vi
    .fn()
    .mockRejectedValueOnce(
      new ArtifactRecordTransportError("consent_required", "Allow first"),
    )
    .mockRejectedValueOnce(new Error("socket hang up"));
  const { request } = setup({ execute }).connect();
  const operation = { op: "get", scope: "shared", collection: "kv", id: "a" };
  assert.deepEqual(await request({ requestId: 1, operation }), {
    requestId: 1,
    ok: false,
    error: { code: "consent_required", message: "Allow first" },
  });
  assert.deepEqual(await request({ requestId: 2, operation }), {
    requestId: 2,
    ok: false,
    error: {
      code: "unavailable",
      message: "Storage is temporarily unavailable",
    },
  });
});

test("pages without a transport are answered, not left waiting", async () => {
  const { request } = setup(null).connect();
  const reply = (await request({
    requestId: 4,
    operation: { op: "get", collection: "kv", id: "a" },
  })) as { error: { code: string } };
  assert.equal(reply.error.code, "unavailable");
});

test("the host rate-limits a busy page", async () => {
  const execute = vi.fn().mockResolvedValue({ op: "delete", deleted: true });
  const { connect, tick } = setup({ execute });
  const { request } = connect();
  const operation = { op: "delete", collection: "kv", id: "a" };
  for (let id = 0; id < 3; id++)
    assert.equal(
      ((await request({ requestId: id, operation })) as { ok: boolean }).ok,
      true,
    );
  const limited = (await request({ requestId: 9, operation })) as {
    error: { code: string };
  };
  assert.equal(limited.error.code, "rate_limited");
  tick(1000);
  assert.equal(
    ((await request({ requestId: 10, operation })) as { ok: boolean }).ok,
    true,
  );
});

test("a second load closes the bridge for good", async () => {
  const execute = vi.fn().mockResolvedValue({ op: "get", record: null });
  const { bridge, connect, send, frame } = setup({ execute });
  assert.equal(bridge.frameLoaded(), "first");
  const { port } = connect();
  assert.equal(bridge.frameLoaded(), "navigated");
  port.postMessage({
    requestId: 1,
    operation: { op: "get", collection: "kv", id: "a" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(execute.mock.calls.length, 0);
  const welcomes = (frame.postMessage as ReturnType<typeof vi.fn>).mock.calls
    .length;
  send({ type: "sourceweft.storage/hello", v: 1 });
  assert.equal(
    (frame.postMessage as ReturnType<typeof vi.fn>).mock.calls.length,
    welcomes,
  );
});

test("a navigation is reported once per document and carries nothing", async () => {
  const reportNavigation = vi.fn().mockResolvedValue(undefined);
  const { bridge } = setup({ execute: vi.fn(), reportNavigation });
  assert.equal(bridge.frameLoaded(), "first");
  assert.equal(reportNavigation.mock.calls.length, 0);
  assert.equal(bridge.frameLoaded(), "navigated");
  bridge.reportNavigation();
  bridge.reportNavigation();
  assert.equal(bridge.frameLoaded(), "navigated");
  bridge.reportNavigation();
  assert.equal(reportNavigation.mock.calls.length, 1);
  assert.deepEqual(reportNavigation.mock.calls[0], []);
});

test("a failing or missing report never disturbs the disconnect", async () => {
  const rejecting = vi.fn().mockRejectedValue(new Error("offline"));
  const first = setup({ execute: vi.fn(), reportNavigation: rejecting });
  first.bridge.frameLoaded();
  assert.equal(first.bridge.frameLoaded(), "navigated");
  assert.doesNotThrow(() => first.bridge.reportNavigation());
  const throwing = vi.fn(() => {
    throw new Error("sync failure");
  });
  const second = setup({ execute: vi.fn(), reportNavigation: throwing });
  second.bridge.frameLoaded();
  second.bridge.frameLoaded();
  assert.doesNotThrow(() => second.bridge.reportNavigation());
  // No transport, or one without the method (public shares): a no-op.
  for (const transport of [null, { execute: vi.fn() }]) {
    const quiet = setup(transport);
    quiet.bridge.frameLoaded();
    quiet.bridge.frameLoaded();
    assert.doesNotThrow(() => quiet.bridge.reportNavigation());
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(rejecting.mock.calls.length, 1);
});

test("only one handshake per document", () => {
  const { send, frame } = setup();
  send({ type: "sourceweft.storage/hello", v: 1 });
  send({ type: "sourceweft.storage/hello", v: 1 });
  const calls = (frame.postMessage as ReturnType<typeof vi.fn>).mock.calls;
  assert.equal(calls.length, 1);
  ports.push(calls[0]![2][0]);
});

test("link requests surface only http(s) URLs to the host", () => {
  const { send, onOpenLink } = setup();
  send({
    type: "sourceweft.navigation/open",
    v: 1,
    url: "javascript:alert(1)",
  });
  send({ type: "sourceweft.navigation/open", v: 1, url: "data:text/html,x" });
  send(
    {
      type: "sourceweft.navigation/open",
      v: 1,
      url: "https://example.com/p?q=1",
    },
    { source: {} },
  );
  assert.equal(onOpenLink.mock.calls.length, 0);
  send({
    type: "sourceweft.navigation/open",
    v: 1,
    url: "https://example.com/p?q=1",
  });
  assert.equal(onOpenLink.mock.calls[0]![0].href, "https://example.com/p?q=1");
});

test("runtime URLs keep existing query strings and fragments", () => {
  assert.equal(
    artifactRuntimeUrl("/f?artifactVersionId=v"),
    "/f?artifactVersionId=v&runtime=1",
  );
  assert.equal(
    artifactRuntimeUrl("https://api/raw"),
    "https://api/raw?runtime=1",
  );
  assert.equal(artifactRuntimeUrl("/f?a=1#top"), "/f?a=1&runtime=1#top");
});

test("a new transport for the same document is used without reconnecting", async () => {
  const first = vi.fn().mockResolvedValue({ op: "get", record: null });
  const second = vi.fn().mockResolvedValue({ op: "get", record: null });
  const { connect, swapTransport, frame } = setup({ execute: first });
  const { request } = connect();
  const operation = { op: "get", collection: "kv", id: "a" };
  await request({ requestId: 1, operation });
  swapTransport({ execute: second });
  await request({ requestId: 2, operation });
  assert.equal(first.mock.calls.length, 1);
  assert.equal(second.mock.calls.length, 1);
  assert.equal(
    (frame.postMessage as ReturnType<typeof vi.fn>).mock.calls.length,
    1,
  );
});
