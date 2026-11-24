// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { HttpClientError } from "@sourceweft/sdk";
import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";
import { AddFeedDialog } from "./add-feed-dialog";

afterEach(unmountAll);

type CheckResult = Awaited<
  ReturnType<Parameters<typeof AddFeedDialog>[0]["onCheck"]>
>;

const okResult: CheckResult = {
  ready: true,
  reason: "",
  message: "",
  title: "Example Blog",
  itemCount: 42,
};

function notReady(reason: string): CheckResult {
  return { ready: false, reason, message: "", title: null, itemCount: null };
}

async function mountDialog(
  overrides: Partial<Parameters<typeof AddFeedDialog>[0]> = {},
) {
  const onCheck = vi.fn().mockResolvedValue(okResult);
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(AddFeedDialog, {
      open: true,
      onOpenChange,
      onCheck,
      onAdd,
      ...overrides,
    }),
  );
  return { onCheck, onAdd, onOpenChange };
}

function urlField() {
  return document.querySelector<HTMLInputElement>('input[name="feedUrl"]')!;
}

function nameField() {
  return document.querySelector<HTMLInputElement>('input[name="feedName"]')!;
}

async function enterUrl(value: string) {
  typeInto(urlField(), value);
  await flush(3);
}

async function checkFeed() {
  await click(button("Check feed"));
  await flush(5);
}

function bodyText() {
  return document.body.textContent ?? "";
}

test("a non-https URL shows the https message and never calls onCheck", async () => {
  const { onCheck } = await mountDialog();

  await enterUrl("http://x/f");
  await checkFeed();

  expect(onCheck).not.toHaveBeenCalled();
  expect(bodyText()).toContain("https://");
  expect(bodyText()).toContain("without a username or password");
});

test("a URL with user:pass@ is rejected with the same message and never calls onCheck", async () => {
  const { onCheck } = await mountDialog();

  await enterUrl("https://user:pw@example.com/feed.xml");
  await checkFeed();

  expect(onCheck).not.toHaveBeenCalled();
  expect(bodyText()).toContain("without a username or password");
});

test("a successful check shows title and count, prefills the name and enables Add", async () => {
  const { onCheck } = await mountDialog();

  await enterUrl("https://example.com/feed.xml?token=SECRET-TOKEN-123");
  expect(button("Add feed").disabled).toBe(true);
  await checkFeed();

  expect(onCheck).toHaveBeenCalledWith(
    "https://example.com/feed.xml?token=SECRET-TOKEN-123",
  );
  expect(bodyText()).toContain("Example Blog");
  expect(bodyText()).toContain("42 items");
  expect(nameField().value).toBe("Example Blog");
  expect(button("Add feed").disabled).toBe(false);
  // The URL is shown without its query; the token is never rendered as text.
  expect(bodyText()).toContain("https://example.com/feed.xml");
  expect(document.body.textContent?.includes("SECRET-TOKEN-123")).toBe(false);
});

test("the token query is not rendered after a failed check either", async () => {
  await mountDialog({
    onCheck: vi.fn().mockResolvedValue(notReady("feed_not_a_feed")),
  });

  await enterUrl("https://example.com/feed.xml?token=SECRET-TOKEN-123");
  await checkFeed();

  expect(bodyText()).not.toMatch(/SECRET-TOKEN-123/);
});

test("editing the URL after a check disables Add again", async () => {
  await mountDialog();

  await enterUrl("https://example.com/feed.xml");
  await checkFeed();
  expect(button("Add feed").disabled).toBe(false);

  await enterUrl("https://example.com/other.xml");
  expect(button("Add feed").disabled).toBe(true);
});

test.each([
  ["feed_blocked_address", "points to an address SourceWeft cannot fetch"],
  ["feed_timeout", "took too long to respond"],
  ["feed_too_large", "too large to index"],
  ["feed_not_a_feed", "does not serve an RSS or Atom feed"],
  ["feed_http_error", "returned an error"],
  ["feed_unreachable", "could not be reached"],
])(
  "a %s check result shows its localized text and keeps Add disabled",
  async (reason, text) => {
    await mountDialog({
      onCheck: vi.fn().mockResolvedValue(notReady(reason)),
    });

    await enterUrl("https://example.com/feed.xml");
    await checkFeed();

    expect(bodyText()).toContain(text);
    expect(button("Add feed").disabled).toBe(true);
  },
);

test("an unknown reason falls back to the generic not-ready text", async () => {
  await mountDialog({
    onCheck: vi.fn().mockResolvedValue(notReady("something_new")),
  });

  await enterUrl("https://example.com/feed.xml");
  await checkFeed();

  expect(bodyText()).toContain("Connector is not ready to sync.");
});

test("a check that throws shows a retryable message and keeps Add disabled", async () => {
  await mountDialog({
    onCheck: vi.fn().mockRejectedValue(new Error("network down")),
  });

  await enterUrl("https://example.com/feed.xml");
  await checkFeed();

  expect(bodyText()).toContain("Could not check this feed");
  expect(button("Add feed").disabled).toBe(true);
});

test("Add submits the checked URL and the typed name, then closes", async () => {
  const { onAdd, onOpenChange } = await mountDialog();

  await enterUrl("https://example.com/feed.xml?token=SECRET-TOKEN-123");
  await checkFeed();
  typeInto(nameField(), "My feed");
  await flush(3);
  await click(button("Add feed"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith({
    name: "My feed",
    feedUrl: "https://example.com/feed.xml?token=SECRET-TOKEN-123",
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("a blank name falls back to the feed title", async () => {
  const { onAdd } = await mountDialog();

  await enterUrl("https://example.com/feed.xml");
  await checkFeed();
  typeInto(nameField(), "   ");
  await flush(3);
  await click(button("Add feed"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith({
    name: "Example Blog",
    feedUrl: "https://example.com/feed.xml",
  });
});

test("a feed without a title falls back to the host for the name", async () => {
  const { onAdd } = await mountDialog({
    onCheck: vi.fn().mockResolvedValue({ ...okResult, title: null }),
  });

  await enterUrl("https://example.com/feed.xml?token=SECRET-TOKEN-123");
  await checkFeed();
  await click(button("Add feed"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith({
    name: "example.com",
    feedUrl: "https://example.com/feed.xml?token=SECRET-TOKEN-123",
  });
});

test("a 409 CONNECTOR_ALREADY_EXISTS shows the name-or-feed conflict text and stays open", async () => {
  const onAdd = vi.fn().mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_ALREADY_EXISTS",
    }),
  );
  const { onOpenChange } = await mountDialog({ onAdd });

  await enterUrl("https://example.com/feed.xml?token=SECRET-TOKEN-123");
  await checkFeed();
  await click(button("Add feed"));
  await flush(5);

  expect(bodyText()).toContain(
    "A connector with this name or this feed already exists in this workspace.",
  );
  expect(bodyText()).not.toMatch(/SECRET-TOKEN-123/);
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("any other add failure shows its message and stays open", async () => {
  const onAdd = vi.fn().mockRejectedValue(new Error("boom"));
  const { onOpenChange } = await mountDialog({ onAdd });

  await enterUrl("https://example.com/feed.xml");
  await checkFeed();
  await click(button("Add feed"));
  await flush(5);

  expect(bodyText()).toContain("boom");
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("a check that finishes after the URL changed is ignored", async () => {
  let resolveCheck: (value: CheckResult) => void = () => {};
  const onCheck = vi.fn().mockReturnValue(
    new Promise<CheckResult>((resolve) => {
      resolveCheck = resolve;
    }),
  );
  await mountDialog({ onCheck });

  await enterUrl("https://example.com/feed.xml");
  await click(button("Check feed"));
  await enterUrl("https://example.com/other.xml");
  resolveCheck(okResult);
  await flush(5);

  expect(button("Add feed").disabled).toBe(true);
  expect(bodyText()).not.toContain("Example Blog");
});
