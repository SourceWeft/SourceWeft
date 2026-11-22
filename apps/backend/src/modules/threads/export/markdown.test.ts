import assert from "node:assert/strict";
import { test } from "vitest";
import { renderChatMarkdown, type RenderableMessage } from "./markdown";

function message(overrides: Partial<RenderableMessage>): RenderableMessage {
  return {
    role: "user",
    author: "Thans",
    createdAt: new Date("2026-11-20T02:31:00Z"),
    content: "",
    stopped: false,
    citations: [],
    attachments: [],
    generatedImages: [],
    artifactLinks: [],
    ...overrides,
  };
}

const base = {
  title: "Q3 budget review",
  exportedAt: new Date("2026-11-22T06:05:00Z"),
  timeZone: "Asia/Shanghai",
  locale: "en" as const,
};

test("renders the spec's sample document", () => {
  const markdown = renderChatMarkdown({
    ...base,
    messages: [
      message({
        content: "What drove the Q3 overspend? Here is a chart:",
        attachments: [{ name: "chart.png", path: "images/01-chart.png" }],
      }),
      message({
        role: "assistant",
        author: null,
        createdAt: new Date("2026-11-20T02:32:00Z"),
        content: "Marketing ran 18% over plan.[citation:c1]",
        citations: [
          {
            citation: "c1",
            sourceTitle: "Q3 budget.xlsx",
            externalUri: null,
            quote: "Marketing: 118% of plan",
          },
        ],
        artifactLinks: [
          { kind: "report", title: "Q3 summary", url: "https://app.example/a" },
        ],
      }),
    ],
  });

  assert.equal(
    markdown,
    [
      "# Q3 budget review",
      "",
      "> Exported from SourceWeft · 2026-11-22 14:05",
      "",
      "## Thans · 2026-11-20 10:31",
      "",
      "What drove the Q3 overspend? Here is a chart:",
      "",
      "![chart.png](images/01-chart.png)",
      "",
      "## Assistant · 2026-11-20 10:32",
      "",
      "Marketing ran 18% over plan.[^1]",
      "",
      "[Report: Q3 summary](https://app.example/a)",
      "",
      '[^1]: Q3 budget.xlsx — "Marketing: 118% of plan"',
      "",
    ].join("\n"),
  );
});

test("missing authors fall back to localized labels", () => {
  const markdown = renderChatMarkdown({
    ...base,
    locale: "zh-CN",
    messages: [
      message({ author: null, content: "问" }),
      message({ role: "assistant", author: null, content: "答" }),
    ],
  });
  assert.match(markdown, /^> 导出自 SourceWeft · 2026-11-22 14:05$/m);
  assert.match(markdown, /^## 用户 · 2026-11-20 10:31$/m);
  assert.match(markdown, /^## 助手 · 2026-11-20 10:31$/m);
});

test("a title that starts with markup is escaped and kept on one line", () => {
  const markdown = renderChatMarkdown({
    ...base,
    title: "# Plan\nnext",
    messages: [],
  });
  assert.equal(markdown.split("\n")[0], "# \\# Plan next");
});

test("an unavailable attachment becomes a placeholder", () => {
  const markdown = renderChatMarkdown({
    ...base,
    messages: [
      message({
        content: "see",
        attachments: [{ name: "chart.png", path: null }],
      }),
    ],
  });
  assert.match(markdown, /^\[Image unavailable: chart\.png\]$/m);
});

test("a generated image replaces its reference in the answer", () => {
  for (const url of [
    "/v1/workspaces/w/artifacts/a9/file",
    "/dashboard/artifacts?artifactId=a9&workspaceId=w",
  ]) {
    const markdown = renderChatMarkdown({
      ...base,
      messages: [
        message({
          role: "assistant",
          content: `Here:\n\n![x](${url})\n\nDone.`,
          generatedImages: [
            { artifactId: "a9", name: "cat.png", path: "images/02-cat.png" },
          ],
        }),
      ],
    });
    assert.match(markdown, /Here:\n\n!\[cat\.png\]\(images\/02-cat\.png\)\n\nDone\./);
    assert.equal(markdown.match(/images\/02-cat\.png/g)?.length, 1);
  }
});

test("a generated image the answer does not mention is appended", () => {
  const markdown = renderChatMarkdown({
    ...base,
    messages: [
      message({
        role: "assistant",
        content: "Made it.",
        generatedImages: [
          { artifactId: "a9", name: "cat.png", path: null },
        ],
      }),
    ],
  });
  assert.match(markdown, /Made it\.\n\n\[Image unavailable: cat\.png\]\n$/);
});

test("artifact links use the kind label, or File when unknown", () => {
  const markdown = renderChatMarkdown({
    ...base,
    messages: [
      message({
        role: "assistant",
        content: "Done.",
        artifactLinks: [
          { kind: "slides", title: "Deck [v2]", url: "https://w/a" },
          { kind: null, title: "Thing", url: "https://w/b" },
        ],
      }),
    ],
  });
  assert.match(markdown, /^\[Slides: Deck \\\[v2\\\]\]\(https:\/\/w\/a\)$/m);
  assert.match(markdown, /^\[File: Thing\]\(https:\/\/w\/b\)$/m);
});

test("a stopped answer ends with a note", () => {
  const markdown = renderChatMarkdown({
    ...base,
    messages: [
      message({ role: "assistant", content: "Partial", stopped: true }),
    ],
  });
  assert.match(markdown, /Partial\n\n_\(Stopped\)_\n$/);
});

test("footnotes follow the message that first cites them and keep numbering", () => {
  const c1 = {
    citation: "c1",
    sourceTitle: "One",
    externalUri: null,
    quote: null,
  };
  const c2 = { ...c1, citation: "c2", sourceTitle: "Two" };
  const markdown = renderChatMarkdown({
    ...base,
    messages: [
      message({
        role: "assistant",
        content: "A[citation:c1]",
        citations: [c1],
      }),
      message({
        role: "assistant",
        content: "B[citation:c2] again[citation:c1]",
        citations: [c1, c2],
      }),
    ],
  });
  assert.match(markdown, /A\[\^1\]\n\n\[\^1\]: One\n\n## /);
  assert.match(markdown, /B\[\^2\] again\[\^1\]\n\n\[\^2\]: Two\n$/);
});
