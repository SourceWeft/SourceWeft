import assert from "node:assert/strict";
import { test } from "vitest";
import { notionAdapter } from "./adapter";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withMockedFetch<T>(
  handler: (input: string, init?: RequestInit) => Response | Promise<Response>,
  run: (
    calls: Array<{
      input: string;
      body: Record<string, unknown>;
      headers: Headers;
    }>,
  ) => Promise<T>,
) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{
    input: string;
    body: Record<string, unknown>;
    headers: Headers;
  }> = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    calls.push({ input: url, body, headers: new Headers(init?.headers) });
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const baseDiscoverInput = {
  teamId: "team_1",
  workspaceId: "workspace_1",
  connectorId: "connector_1",
  connectorType: "notion",
  config: {
    includePages: true,
  },
  accessToken: "token",
};

test("notion adapter declares install-integration OAuth manifest", () => {
  const manifest = notionAdapter.getManifest();

  assert.equal(manifest.type, "notion");
  assert.equal(
    manifest.auth.authorizationUrl,
    "https://www.notion.so/install-integration",
  );
  assert.equal(manifest.auth.tokenUrl, "https://api.notion.com/v1/oauth/token");
  assert.deepEqual(manifest.auth.scopes, []);
  assert.equal(manifest.auth.sendScope, false);
  assert.deepEqual(manifest.auth.authorizationParams, {
    client_id: process.env.NOTION_CLIENT_ID?.trim() ?? "",
    owner: "user",
  });
  assert.ok(
    manifest.actions.some((action) => action.type === "notion.page.create"),
  );
  assert.ok(
    manifest.sync.resources.some((resource) => resource.type === "notion_page"),
  );
  assert.deepEqual(
    manifest.sync.resources.map((resource) => resource.type),
    ["notion_page"],
  );
  assert.deepEqual(manifest.configSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      includePages: { type: "boolean" },
    },
  });
});

test("notion adapter manifest does not require OAuth env at startup", () => {
  const originalClientId = process.env.NOTION_CLIENT_ID;
  delete process.env.NOTION_CLIENT_ID;

  try {
    const manifest = notionAdapter.getManifest();
    assert.deepEqual(manifest.auth.authorizationParams, {
      client_id: "",
      owner: "user",
    });
  } finally {
    if (originalClientId === undefined) {
      delete process.env.NOTION_CLIENT_ID;
    } else {
      process.env.NOTION_CLIENT_ID = originalClientId;
    }
  }
});

test("notion client always sends API version 2026-03-11", async () => {
  await withMockedFetch(
    () => jsonResponse({ results: [{ object: "page", id: "page_1" }] }),
    async (calls) => {
      for await (const _item of notionAdapter.discover(baseDiscoverInput)) {
        // Exhaust the generator so the search request is issued.
      }

      assert.equal(calls[0]?.headers.get("notion-version"), "2026-03-11");
    },
  );
});

test("notion action schemas require approval for writes", () => {
  const manifest = notionAdapter.getManifest();
  const writeActions = manifest.actions.filter(
    (action) =>
      action.type !== "notion.data_source.query" &&
      action.type !== "notion.page.find" &&
      action.type !== "notion.page.read",
  );

  assert.ok(writeActions.length > 0);
  for (const action of writeActions) {
    assert.equal(action.requiresApproval, true);
  }
});

test("notion adapter declares expanded actions", () => {
  const actionTypes = new Set(
    notionAdapter.getManifest().actions.map((action) => action.type),
  );

  assert.ok(actionTypes.has("notion.page.find"));
  assert.ok(actionTypes.has("notion.page.read"));
  assert.ok(actionTypes.has("notion.page.save_artifact"));
  assert.ok(actionTypes.has("notion.page.save_final_answer"));
  assert.ok(actionTypes.has("notion.page.update"));
  assert.ok(actionTypes.has("notion.page.trash"));
  assert.ok(actionTypes.has("notion.file_upload.create"));
  assert.ok(actionTypes.has("notion.file_upload.attach_to_page"));
});

test("notion agent-visible actions declare tool metadata", () => {
  const agentActions = notionAdapter
    .getManifest()
    .actions.filter((action) => action.visibility === "agent");

  assert.ok(agentActions.length > 0);
  for (const action of agentActions) {
    assert.equal(typeof action.agentToolName, "string");
    assert.ok(action.agentToolName?.length);
    assert.equal(typeof action.description, "string");
    assert.ok(action.description?.length);
    assert.ok(action.capabilities?.length);
  }
});

test("notion create action describes workspace-default target overrides", () => {
  const createAction = notionAdapter
    .getManifest()
    .actions.find((action) => action.type === "notion.page.create");
  assert.ok(createAction);

  assert.match(createAction.description ?? "", /authorized workspace/);
  assert.match(createAction.description ?? "", /Only include parentPageId\/pageId or dataSourceId/);
  const schema = createAction.inputSchema as {
    properties?: Record<string, { description?: string }>;
    required?: string[];
  };
  assert.deepEqual(schema.required, ["title", "content"]);
  assert.match(schema.properties?.parentPageId?.description ?? "", /Omit by default/);
  assert.match(schema.properties?.pageId?.description ?? "", /Omit by default/);
  assert.match(schema.properties?.dataSourceId?.description ?? "", /Omit by default/);
});

test("notion find action describes required search query", () => {
  const findAction = notionAdapter
    .getManifest()
    .actions.find((action) => action.type === "notion.page.find");
  assert.ok(findAction);

  assert.match(findAction.description ?? "", /Always pass query as non-empty/);
  assert.match(findAction.description ?? "", /ask the user what page to find/);
  const schema = findAction.inputSchema as {
    properties?: Record<string, { description?: string }>;
    required?: string[];
  };
  assert.deepEqual(schema.required, ["query"]);
  assert.match(schema.properties?.query?.description ?? "", /Required non-empty/);
  assert.match(schema.properties?.query?.description ?? "", /user's request/);
});

test("notion readiness checks only page access with page_size 1", async () => {
  assert.ok(notionAdapter.checkSyncReadiness);

  await withMockedFetch(
    () => jsonResponse({ results: [], has_more: false }),
    async (calls) => {
      const result =
        await notionAdapter.checkSyncReadiness?.(baseDiscoverInput);

      assert.equal(result?.ready, false);
      assert.equal(result?.reason, "notion_no_pages");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.body, {
        filter: { property: "object", value: "page" },
        page_size: 1,
      });
    },
  );
});

test("notion discover indexes pages only and never sends database filter", async () => {
  await withMockedFetch(
    () =>
      jsonResponse({
        results: [
          {
            object: "page",
            id: "page_1",
            url: "https://www.notion.so/page_1",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Page One" }],
              },
            },
          },
        ],
        has_more: false,
      }),
    async (calls) => {
      const items = [];
      for await (const item of notionAdapter.discover(baseDiscoverInput)) {
        items.push(item);
      }

      assert.equal(items.length, 1);
      assert.equal(items[0]?.externalId, "page:page_1");
      assert.ok(
        calls.some(
          (call) =>
            (call.body.filter as Record<string, unknown> | undefined)?.value ===
            "page",
        ),
      );
      assert.equal(
        calls.some(
          (call) =>
            (call.body.filter as Record<string, unknown> | undefined)?.value ===
            "database",
        ),
        false,
      );
      assert.equal(
        calls.some(
          (call) =>
            (call.body.filter as Record<string, unknown> | undefined)?.value ===
            "data_source",
        ),
        false,
      );
    },
  );
});

test("notion page find sends query and page filter without nesting", async () => {
  await withMockedFetch(
    () => jsonResponse({ results: [], has_more: false }),
    async (calls) => {
      await notionAdapter.executeAction({
        ...baseDiscoverInput,
        actionType: "notion.page.find",
        request: { query: "Roadmap" },
        idempotencyKey: "find_1",
      });

      assert.deepEqual(calls[0]?.body, {
        query: "Roadmap",
        filter: { property: "object", value: "page" },
      });
    },
  );
});

test("notion create page omits parent for public OAuth private workspace pages", async () => {
  await withMockedFetch(
    (url) => {
      if (url.endsWith("/pages")) {
        return jsonResponse({
          object: "page",
          id: "page_1",
          url: "https://www.notion.so/page_1",
        });
      }
      return jsonResponse({});
    },
    async (calls) => {
      await notionAdapter.executeAction({
        ...baseDiscoverInput,
        actionType: "notion.page.create",
        request: { title: "Private Note", content: "Hello" },
        idempotencyKey: "create_private_1",
      });

      assert.deepEqual(calls[0]?.body, {
        properties: {
          title: {
            title: [{ type: "text", text: { content: "Private Note" } }],
          },
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: "Hello" } }],
            },
          },
        ],
      });
    },
  );
});

test("notion page trash action accepts batch page ids", async () => {
  await withMockedFetch(
    () => jsonResponse({ object: "page" }),
    async (calls) => {
      const result = await notionAdapter.executeAction({
        ...baseDiscoverInput,
        actionType: "notion.page.trash",
        request: { pageIds: ["page_1", "page_2"] },
        idempotencyKey: "trash_batch_1",
      });

      assert.deepEqual(
        calls.map((call) => call.input),
        [
          "https://api.notion.com/v1/pages/page_1",
          "https://api.notion.com/v1/pages/page_2",
        ],
      );
      assert.deepEqual(
        calls.map((call) => call.body),
        [{ in_trash: true }, { in_trash: true }],
      );
      assert.deepEqual(result.resyncExternalIds, ["page:page_1", "page:page_2"]);
      assert.deepEqual(result.result.pageIds, ["page_1", "page_2"]);
      assert.equal(result.result.count, 2);
    },
  );
});

test("notion page read action returns markdown by page id", async () => {
  await withMockedFetch(
    (url) => {
      if (url.includes("/pages/page_1")) {
        return jsonResponse({
          object: "page",
          id: "page_1",
          url: "https://www.notion.so/page_1",
          last_edited_time: "2026-05-02T00:00:00.000Z",
          parent: { type: "workspace", workspace: true },
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Roadmap" }],
            },
            Status: {
              type: "status",
              status: { name: "Draft" },
            },
          },
        });
      }
      if (url.includes("/blocks/page_1/children")) {
        return jsonResponse({
          results: [
            {
              object: "block",
              id: "block_1",
              type: "paragraph",
              has_children: false,
              paragraph: {
                rich_text: [{ plain_text: "Hello from Notion" }],
              },
            },
          ],
          has_more: false,
        });
      }
      return jsonResponse({ results: [], has_more: false });
    },
    async () => {
      const result = await notionAdapter.executeAction({
        ...baseDiscoverInput,
        actionType: "notion.page.read",
        request: { pageId: "page_1" },
        idempotencyKey: "read_1",
      });

      assert.equal(result.result.pageId, "page_1");
      assert.equal(result.result.title, "Roadmap");
      assert.match(String(result.result.markdown), /Hello from Notion/);
      assert.deepEqual(result.rawResponseJson, [
        {
          body: {
            object: "page",
            id: "page_1",
            url: "https://www.notion.so/page_1",
            last_edited_time: "2026-05-02T00:00:00.000Z",
            parent: { type: "workspace", workspace: true },
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Roadmap" }],
              },
              Status: {
                type: "status",
                status: { name: "Draft" },
              },
            },
          },
          method: "GET",
          path: "/pages/page_1",
          status: 200,
        },
        {
          body: {
            results: [
              {
                object: "block",
                id: "block_1",
                type: "paragraph",
                has_children: false,
                paragraph: {
                  rich_text: [{ plain_text: "Hello from Notion" }],
                },
              },
            ],
            has_more: false,
          },
          method: "GET",
          path: "/blocks/page_1/children",
          status: 200,
        },
      ]);
      assert.deepEqual(
        (result.result.properties as Record<string, unknown>).Status,
        { type: "status", value: "Draft" },
      );
      assert.equal(result.result.truncated, false);
    },
  );
});

test("notion page update action replaces content by page id", async () => {
  await withMockedFetch(
    (url) => {
      if (url.includes("/blocks/page_1/children")) {
        return jsonResponse({
          results: [
            {
              object: "block",
              id: "block_1",
              type: "paragraph",
              archived: false,
              paragraph: {
                rich_text: [{ plain_text: "Old content" }],
              },
            },
          ],
          has_more: false,
        });
      }
      return jsonResponse({ object: "page", id: "page_1" });
    },
    async (calls) => {
      const result = await notionAdapter.executeAction({
        ...baseDiscoverInput,
        actionType: "notion.page.update",
        request: {
          pageId: "page_1",
          mode: "replace",
          properties: {
            Status: {
              status: { name: "Done" },
            },
          },
          content: "## New plan\nShip it",
        },
        idempotencyKey: "update_1",
      });

      assert.deepEqual(calls[0]?.body, {
        properties: {
          Status: {
            status: { name: "Done" },
          },
        },
      });
      assert.deepEqual(calls[2]?.body, { archived: true });
      assert.deepEqual(calls[3]?.body, {
        children: [
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [{ type: "text", text: { content: "New plan" } }],
            },
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: "Ship it" } }],
            },
          },
        ],
      });
      assert.equal(result.result.pageId, "page_1");
      assert.equal(result.result.mode, "replace");
      assert.equal(result.result.replacedBlockCount, 1);
      assert.deepEqual(result.result.propertyNames, ["Status"]);
    },
  );
});

test("notion create page sends explicit page or data source parent when provided", async () => {
  await withMockedFetch(
    (url) => {
      if (url.endsWith("/pages")) {
        return jsonResponse({
          object: "page",
          id: "created_page",
          url: "https://www.notion.so/created_page",
        });
      }
      return jsonResponse({});
    },
    async (calls) => {
      await notionAdapter.executeAction({
        ...baseDiscoverInput,
        actionType: "notion.page.create",
        request: {
          title: "Under Page",
          content: "Hello",
          parentPageId: "parent_page_1",
        },
        idempotencyKey: "create_parent_1",
      });
      await notionAdapter.executeAction({
        ...baseDiscoverInput,
        actionType: "notion.page.create",
        request: {
          title: "In Data Source",
          content: "Hello",
          dataSourceId: "data_source_1",
        },
        idempotencyKey: "create_ds_1",
      });

      assert.deepEqual(calls[0]?.body.parent, { page_id: "parent_page_1" });
      assert.deepEqual(calls[1]?.body.parent, {
        data_source_id: "data_source_1",
      });
    },
  );
});

test("notion extract sanitizes file urls and records unsupported blocks", async () => {
  await withMockedFetch(
    (url) => {
      if (url.includes("/pages/page_1")) {
        return jsonResponse({
          object: "page",
          id: "page_1",
          url: "https://www.notion.so/page_1",
          last_edited_time: "2026-05-01T00:00:00.000Z",
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Page One" }],
            },
          },
        });
      }
      if (url.includes("/blocks/page_1/children")) {
        return jsonResponse({
          results: [
            {
              object: "block",
              id: "block_1",
              type: "paragraph",
              has_children: false,
              paragraph: {
                rich_text: [{ plain_text: "Hello" }],
              },
            },
            {
              object: "block",
              id: "block_2",
              type: "image",
              has_children: false,
              image: {
                type: "file",
                file: {
                  url: "https://s3.us-west-2.amazonaws.com/notion-file?X-Amz-Signature=secret",
                },
              },
            },
            {
              object: "block",
              id: "block_3",
              type: "unsupported",
              has_children: false,
              unsupported: {},
            },
          ],
          has_more: false,
        });
      }
      return jsonResponse({ results: [], has_more: false });
    },
    async () => {
      const result = await notionAdapter.extract({
        ...baseDiscoverInput,
        item: {
          externalId: "page:page_1",
          externalUri: "https://www.notion.so/page_1",
          title: "Page One",
          mimeType: "text/markdown",
          sizeBytes: null,
          externalUpdatedAt: null,
          contentHash: null,
          metadata: {
            object: "page",
            notionId: "page_1",
          },
        },
      });

      assert.match(result.markdown ?? "", /Hello/);
      assert.match(result.markdown ?? "", /Notion image/);
      assert.doesNotMatch(result.markdown ?? "", /X-Amz-Signature/);
      assert.deepEqual(result.item.metadata.skippedBlockTypes, ["unsupported"]);
      assert.equal(result.item.metadata.skippedBlockCount, 1);
    },
  );
});

test("notion extract projects properties and hierarchy into markdown and metadata", async () => {
  await withMockedFetch(
    (url) => {
      if (url.includes("/pages/page_1")) {
        return jsonResponse({
          object: "page",
          id: "page_1",
          url: "https://www.notion.so/page_1",
          created_time: "2026-05-01T00:00:00.000Z",
          last_edited_time: "2026-05-02T00:00:00.000Z",
          parent: { type: "page_id", page_id: "parent_1" },
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Webhook" }],
            },
            Status: {
              type: "status",
              status: { name: "Done" },
            },
            Project: {
              type: "relation",
              relation: [{ id: "project_1" }],
            },
            Due: {
              type: "date",
              date: null,
            },
            Mystery: {
              type: "unsupported_custom",
              unsupported_custom: {},
            },
          },
        });
      }
      if (url.includes("/pages/parent_1")) {
        return jsonResponse({
          object: "page",
          id: "parent_1",
          url: "https://www.notion.so/parent_1",
          parent: { type: "workspace", workspace: true },
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "AnyCrawl" }],
            },
          },
        });
      }
      if (url.includes("/pages/project_1")) {
        return jsonResponse({
          object: "page",
          id: "project_1",
          url: "https://www.notion.so/project_1",
          parent: { type: "workspace", workspace: true },
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "AnyCrawl Project" }],
            },
          },
        });
      }
      if (url.includes("/blocks/page_1/children")) {
        return jsonResponse({
          results: [
            {
              object: "block",
              id: "block_1",
              type: "paragraph",
              has_children: false,
              paragraph: {
                rich_text: [{ plain_text: "Body content" }],
              },
            },
          ],
          has_more: false,
        });
      }
      return jsonResponse({ results: [], has_more: false });
    },
    async () => {
      const result = await notionAdapter.extract({
        ...baseDiscoverInput,
        connectorName: "Lei Qin - Notion",
        item: {
          externalId: "page:page_1",
          externalUri: "https://www.notion.so/page_1",
          title: "Webhook",
          mimeType: "text/markdown",
          sizeBytes: null,
          externalUpdatedAt: null,
          contentHash: null,
          metadata: {
            object: "page",
            notionId: "page_1",
          },
        },
      });

      const markdown = result.markdown ?? "";
      assert.doesNotMatch(markdown, /## Source/);
      assert.doesNotMatch(markdown, /## Notion Location/);
      assert.doesNotMatch(markdown, /Path: AnyCrawl \/ Webhook/);
      assert.match(markdown, /## Notion Properties/);
      assert.match(
        markdown,
        /## Notion Properties\n- Status: Done\n- Project: AnyCrawl Project/,
      );
      assert.match(markdown, /Status: Done/);
      assert.match(markdown, /Project: AnyCrawl Project/);
      assert.doesNotMatch(markdown, /Due:/);
      assert.match(markdown, /## Content/);
      assert.match(markdown, /Body content/);

      const notion = result.item.metadata.notion as Record<string, unknown>;
      assert.equal(notion.path, "AnyCrawl / Webhook");
      assert.equal(notion.parentType, "page");
      assert.equal(notion.containerName, null);
      assert.deepEqual(notion.directoryExternalIds, [
        "notion-dir:connector:connector_1",
        "notion-dir:page:parent_1",
      ]);
      assert.deepEqual(notion.emptyPropertyNames, ["Due", "Mystery"]);
      assert.deepEqual(notion.propertySummary, [
        "Status: Done",
        "Project: AnyCrawl Project",
      ]);
      assert.deepEqual(notion.unsupportedPropertyTypes, ["unsupported_custom"]);
      assert.deepEqual(
        result.directoryPath?.map((node) => [node.externalId, node.title]),
        [
          ["notion-dir:connector:connector_1", "Notion"],
          ["notion-dir:page:parent_1", "AnyCrawl"],
        ],
      );
    },
  );
});

test("notion extract returns data source directory path and container metadata", async () => {
  await withMockedFetch(
    (url) => {
      if (url.includes("/pages/page_1")) {
        return jsonResponse({
          object: "page",
          id: "page_1",
          url: "https://www.notion.so/page_1",
          last_edited_time: "2026-05-02T00:00:00.000Z",
          parent: { type: "data_source_id", data_source_id: "ds_1" },
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "KW: instagram photo scraper" }],
            },
          },
        });
      }
      if (url.includes("/data_sources/ds_1")) {
        return jsonResponse({
          object: "data_source",
          id: "ds_1",
          url: "https://www.notion.so/ds_1",
          parent: { type: "page_id", page_id: "tasks_1" },
          title: [{ plain_text: "Projects & Tasks" }],
          properties: {},
        });
      }
      if (url.includes("/pages/tasks_1")) {
        return jsonResponse({
          object: "page",
          id: "tasks_1",
          url: "https://www.notion.so/tasks_1",
          parent: { type: "workspace", workspace: true },
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Tasks" }],
            },
          },
        });
      }
      if (url.includes("/blocks/page_1/children")) {
        return jsonResponse({ results: [], has_more: false });
      }
      return jsonResponse({ results: [], has_more: false });
    },
    async () => {
      const result = await notionAdapter.extract({
        ...baseDiscoverInput,
        item: {
          externalId: "page:page_1",
          externalUri: "https://www.notion.so/page_1",
          title: "KW: instagram photo scraper",
          mimeType: "text/markdown",
          sizeBytes: null,
          externalUpdatedAt: null,
          contentHash: null,
          metadata: {
            object: "page",
            notionId: "page_1",
          },
        },
      });

      const notion = result.item.metadata.notion as Record<string, unknown>;
      assert.equal(
        notion.path,
        "Tasks / Projects & Tasks / KW: instagram photo scraper",
      );
      assert.equal(notion.parentType, "data_source");
      assert.equal(notion.containerName, "Projects & Tasks");
      assert.deepEqual(
        result.directoryPath?.map((node) => [node.externalId, node.title]),
        [
          ["notion-dir:connector:connector_1", "Notion"],
          ["notion-dir:page:tasks_1", "Tasks"],
          ["notion-dir:data_source:ds_1", "Projects & Tasks"],
        ],
      );
    },
  );
});

test("notion extract does not use unresolved parent ids as directory names", async () => {
  const inaccessibleParentId = "2e4dadfc-4a0b-8158-9242-e5e5828c6dd5";

  await withMockedFetch(
    (url) => {
      if (url.includes("/pages/page_1")) {
        return jsonResponse({
          object: "page",
          id: "page_1",
          url: "https://www.notion.so/page_1",
          last_edited_time: "2026-05-02T00:00:00.000Z",
          parent: { type: "page_id", page_id: inaccessibleParentId },
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Leaf Page" }],
            },
          },
        });
      }
      if (url.includes(`/pages/${inaccessibleParentId}`)) {
        return jsonResponse(
          {
            object: "error",
            code: "object_not_found",
            message: "Could not find parent page",
          },
          404,
        );
      }
      if (url.includes("/blocks/page_1/children")) {
        return jsonResponse({ results: [], has_more: false });
      }
      return jsonResponse({ results: [], has_more: false });
    },
    async () => {
      const result = await notionAdapter.extract({
        ...baseDiscoverInput,
        item: {
          externalId: "page:page_1",
          externalUri: "https://www.notion.so/page_1",
          title: "Leaf Page",
          mimeType: "text/markdown",
          sizeBytes: null,
          externalUpdatedAt: null,
          contentHash: null,
          metadata: {
            object: "page",
            notionId: "page_1",
          },
        },
      });

      const notion = result.item.metadata.notion as Record<string, unknown>;
      const parent = notion.parent as Record<string, unknown>;

      assert.equal(notion.path, "Leaf Page");
      assert.equal(parent.id, inaccessibleParentId);
      assert.equal(parent.title, "");
      assert.equal(
        result.directoryPath?.some(
          (node) => node.title === inaccessibleParentId,
        ),
        false,
      );
      assert.deepEqual(
        result.directoryPath?.map((node) => [node.externalId, node.title]),
        [["notion-dir:connector:connector_1", "Notion"]],
      );
    },
  );
});

test("notion webhook parser maps page update to targeted sync", async () => {
  assert.ok(notionAdapter.parseWebhookEvent);
  assert.ok(notionAdapter.mapWebhookEventToSyncTargets);

  const event = await notionAdapter.parseWebhookEvent({
    headers: {},
    query: {},
    rawBody: JSON.stringify({
      id: "evt_1",
      type: "page.content_updated",
      workspace_id: "workspace_1",
      data: {
        object: "page",
        id: "page_1",
      },
    }),
  });
  const targets = await notionAdapter.mapWebhookEventToSyncTargets(event);

  assert.equal(event.providerEventId, "evt_1");
  assert.equal(event.workspaceHint, "workspace_1");
  assert.deepEqual(targets, [
    {
      action: "sync",
      externalId: "page:page_1",
      objectId: "page_1",
      objectType: "page",
    },
  ]);
});

test("notion webhook parser records verification token", async () => {
  assert.ok(notionAdapter.parseWebhookEvent);
  assert.ok(notionAdapter.mapWebhookEventToSyncTargets);

  const event = await notionAdapter.parseWebhookEvent({
    headers: {},
    query: {},
    rawBody: JSON.stringify({
      verification_token: "verify-me",
      workspace_id: "workspace_1",
    }),
  });
  const targets = await notionAdapter.mapWebhookEventToSyncTargets(event);

  assert.equal(event.eventType, "webhook.verification");
  assert.equal(event.metadata.verificationToken, "verify-me");
  assert.deepEqual(targets, [
    { action: "record_only", reason: "verification" },
  ]);
});

test("notion webhook verification rejects bad signature when secret is configured", async () => {
  assert.ok(notionAdapter.verifyWebhook);
  const verifyWebhook = notionAdapter.verifyWebhook;
  const previousSecret = process.env.NOTION_WEBHOOK_SECRET;
  process.env.NOTION_WEBHOOK_SECRET = "secret";
  await assert.rejects(
    () =>
      verifyWebhook({
        headers: { "x-notion-signature": "sha256=bad" },
        query: {},
        rawBody: "{}",
      }),
    /Notion webhook signature is invalid/,
  );
  if (previousSecret === undefined) {
    delete process.env.NOTION_WEBHOOK_SECRET;
  } else {
    process.env.NOTION_WEBHOOK_SECRET = previousSecret;
  }
});

test("notion webhook parser maps page delete to archive source", async () => {
  assert.ok(notionAdapter.parseWebhookEvent);
  assert.ok(notionAdapter.mapWebhookEventToSyncTargets);

  const event = await notionAdapter.parseWebhookEvent({
    headers: {},
    query: {},
    rawBody: JSON.stringify({
      id: "evt_2",
      type: "page.deleted",
      workspace_id: "workspace_1",
      data: {
        object: "page",
        id: "page_1",
      },
    }),
  });
  const targets = await notionAdapter.mapWebhookEventToSyncTargets(event);

  assert.deepEqual(targets, [
    {
      action: "archive_source",
      externalId: "page:page_1",
      objectId: "page_1",
      objectType: "page",
    },
  ]);
});

test("notion webhook data source changes rediscover pages but database changes are record-only", async () => {
  assert.ok(notionAdapter.parseWebhookEvent);
  assert.ok(notionAdapter.mapWebhookEventToSyncTargets);

  const dataSourceEvent = await notionAdapter.parseWebhookEvent({
    headers: {},
    query: {},
    rawBody: JSON.stringify({
      id: "evt_ds",
      type: "data_source.updated",
      data: {
        object: "data_source",
        id: "ds_1",
      },
    }),
  });
  assert.deepEqual(
    await notionAdapter.mapWebhookEventToSyncTargets(dataSourceEvent),
    [
      {
        action: "sync",
        objectId: "ds_1",
        objectType: "data_source",
        reason: "data source event requires page rediscovery",
      },
    ],
  );

  const databaseEvent = await notionAdapter.parseWebhookEvent({
    headers: {},
    query: {},
    rawBody: JSON.stringify({
      id: "evt_db",
      type: "database.updated",
      data: {
        object: "database",
        id: "db_1",
      },
    }),
  });
  assert.deepEqual(
    await notionAdapter.mapWebhookEventToSyncTargets(databaseEvent),
    [{ action: "record_only", reason: "not indexable" }],
  );
});
