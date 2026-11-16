import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorManifestSchema,
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
} from "../src/connectors";

const entry = {
  id: "id:a",
  kind: "file",
  name: "a.pdf",
  detail: "/a.pdf",
  selectable: true,
  expandable: false,
  disabledReason: null,
  size: 10,
  modifiedAt: "2026-11-01T00:00:00Z",
};

test("browse result strips unknown keys and defaults helpLink", () => {
  const parsed = connectorSelectionBrowseResultSchema.parse({
    container: null,
    breadcrumbs: [],
    cursor: "",
    hasMore: false,
    entries: [{ ...entry, accessToken: "secret", raw: { x: 1 } }],
    extra: true,
  });
  assert.deepEqual(parsed, {
    container: null,
    breadcrumbs: [],
    cursor: "",
    hasMore: false,
    entries: [entry],
    helpLink: null,
  });
});

test("helpLink must be https", () => {
  const base = {
    container: null,
    breadcrumbs: [],
    entries: [],
    cursor: "",
    hasMore: false,
  };
  assert.ok(
    connectorSelectionBrowseResultSchema.safeParse({
      ...base,
      helpLink: {
        code: "add",
        url: "https://github.com/apps/x/installations/new",
      },
    }).success,
  );
  for (const url of ["http://github.com/x", "javascript:alert(1)", "not a url"]) {
    assert.equal(
      connectorSelectionBrowseResultSchema.safeParse({
        ...base,
        helpLink: { code: "add", url },
      }).success,
      false,
    );
  }
});

test("bounds are enforced", () => {
  const base = {
    container: null,
    breadcrumbs: [],
    entries: [],
    cursor: "",
    hasMore: false,
  };

  const tooManyEntries = {
    ...base,
    entries: Array.from({ length: 501 }, (_, index) => ({
      ...entry,
      id: `id:${index}`,
    })),
  };
  assert.equal(
    connectorSelectionBrowseResultSchema.safeParse(tooManyEntries).success,
    false,
  );

  const tooLongEntryId = {
    ...base,
    entries: [{ ...entry, id: "x".repeat(513) }],
  };
  assert.equal(
    connectorSelectionBrowseResultSchema.safeParse(tooLongEntryId).success,
    false,
  );

  const tooManyBreadcrumbs = {
    ...base,
    breadcrumbs: Array.from({ length: 51 }, (_, index) => ({
      id: `b${index}`,
      name: `b${index}`,
    })),
  };
  assert.equal(
    connectorSelectionBrowseResultSchema.safeParse(tooManyBreadcrumbs).success,
    false,
  );

  const tooLongCursor = {
    ...base,
    cursor: "x".repeat(4097),
  };
  assert.equal(
    connectorSelectionBrowseResultSchema.safeParse(tooLongCursor).success,
    false,
  );
});

test("describe keeps nulls for a missing item and defaults meta", () => {
  const parsed = connectorSelectionDescribeResultSchema.parse({
    items: [
      { id: "id:gone", kind: null, name: null, detail: null, exists: false },
    ],
  });
  assert.deepEqual(parsed.items[0], {
    id: "id:gone",
    kind: null,
    name: null,
    detail: null,
    exists: false,
    meta: {},
  });

  const tooManyItems = {
    items: Array.from({ length: 101 }, (_, index) => ({
      id: `id:${index}`,
      kind: null,
      name: null,
      detail: null,
      exists: false,
    })),
  };
  assert.equal(
    connectorSelectionDescribeResultSchema.safeParse(tooManyItems).success,
    false,
  );

  const metaWithObjectValue = {
    items: [
      {
        id: "id:a",
        kind: null,
        name: null,
        detail: null,
        exists: true,
        meta: { nested: { x: 1 } },
      },
    ],
  };
  assert.equal(
    connectorSelectionDescribeResultSchema.safeParse(metaWithObjectValue)
      .success,
    false,
  );
});

test("manifest accepts and omits selection", () => {
  const minimalManifest = {
    type: "dropbox",
    displayName: "Dropbox",
    auth: {
      kind: "oauth2",
      authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scopes: [],
    },
    sync: {
      supportsIncremental: false,
      defaultFrequencyMinutes: 60,
      resources: [],
    },
    actions: [],
    configSchema: { type: "object" },
  };

  const withoutSelection = connectorManifestSchema.parse(minimalManifest);
  assert.equal(withoutSelection.selection, undefined);

  const withSelection = connectorManifestSchema.parse({
    ...minimalManifest,
    selection: {
      actions: { browse: "dropbox.browse", describe: "dropbox.describe" },
      kinds: ["file"],
      maxItems: 500,
    },
  });
  assert.deepEqual(withSelection.selection, {
    actions: { browse: "dropbox.browse", describe: "dropbox.describe" },
    kinds: ["file"],
    maxItems: 500,
  });
});
