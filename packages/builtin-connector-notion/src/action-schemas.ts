export const notionActionInputSchemas = {
  "notion.page.create": {
    type: "object",
    required: ["title", "content"],
    additionalProperties: true,
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      parentPageId: {
        type: "string",
        description:
          "Optional explicit parent page ID. Omit by default so Notion creates the page in the authorized workspace selected by this connector.",
      },
      pageId: {
        type: "string",
        description:
          "Optional alias for parentPageId. Omit by default unless the user explicitly requested and confirmed a parent page.",
      },
      dataSourceId: {
        type: "string",
        description:
          "Optional explicit data source ID. Omit by default unless the user explicitly requested and confirmed a target data source.",
      },
      sourceId: { type: "string" },
      targetHint: { type: "string" },
    },
  },
  "notion.page.save_artifact": {
    type: "object",
    required: ["title", "artifactId"],
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      artifactId: { type: "string" },
      artifactUrl: { type: "string" },
    },
  },
  "notion.page.save_final_answer": {
    type: "object",
    required: ["title", "content"],
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      content: { type: "string" },
    },
  },
  "notion.page.append": {
    type: "object",
    required: ["pageId", "content"],
    additionalProperties: true,
    properties: {
      pageId: { type: "string" },
      content: { type: "string" },
    },
  },
  "notion.page.update_properties": {
    type: "object",
    required: ["pageId", "properties"],
    additionalProperties: true,
    properties: {
      pageId: { type: "string" },
      properties: { type: "object" },
    },
  },
  "notion.page.trash": {
    type: "object",
    anyOf: [{ required: ["pageId"] }, { required: ["pageIds"] }],
    additionalProperties: false,
    properties: {
      pageId: {
        type: "string",
        description:
          "Single Notion page ID to move to trash. Prefer pageIds for batch deletion.",
      },
      pageIds: {
        type: "array",
        items: { type: "string" },
        description:
          "One or more Notion page IDs to move to trash. Use this for duplicate-title or batch deletion.",
      },
      deleteFromKnowledgeBase: { type: "boolean" },
    },
  },
  "notion.comment.create": {
    type: "object",
    required: ["richText"],
    additionalProperties: true,
    properties: {
      pageId: { type: "string" },
      discussionId: { type: "string" },
      richText: { type: "string" },
    },
  },
  "notion.data_source.query": {
    type: "object",
    required: ["dataSourceId"],
    additionalProperties: true,
    properties: {
      dataSourceId: { type: "string" },
      filter: { type: "object" },
      sorts: { type: "array" },
    },
  },
  "notion.page.find": {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description:
          "Required non-empty Notion page search text from the user's request, usually a title, keyword, or topic.",
      },
    },
  },
  "notion.page.read": {
    type: "object",
    required: ["pageId"],
    additionalProperties: false,
    properties: {
      pageId: { type: "string" },
      includeProperties: { type: "boolean" },
      includeContent: { type: "boolean" },
      maxChars: { type: "number" },
    },
  },
  "notion.page.update": {
    type: "object",
    required: ["pageId"],
    additionalProperties: true,
    properties: {
      pageId: { type: "string" },
      content: { type: "string" },
      mode: {
        type: "string",
        enum: ["append", "replace"],
        description:
          "append adds markdown blocks after existing content. replace archives existing top-level blocks before writing content.",
      },
      properties: { type: "object" },
    },
  },
  "notion.file_upload.create": {
    type: "object",
    required: ["fileName"],
    additionalProperties: true,
    properties: {
      fileName: { type: "string" },
      contentType: { type: "string" },
      mode: { type: "string" },
    },
  },
  "notion.file_upload.attach_to_page": {
    type: "object",
    required: ["pageId", "fileUploadId", "fileName"],
    additionalProperties: true,
    properties: {
      pageId: { type: "string" },
      fileUploadId: { type: "string" },
      fileName: { type: "string" },
    },
  },
} as const satisfies Record<string, Readonly<Record<string, unknown>>>;
