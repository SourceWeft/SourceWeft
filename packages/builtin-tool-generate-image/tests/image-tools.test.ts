import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArtifactPreviewUrl,
  createGenerateImageTool,
  buildImageRuntimePromptLines,
  buildImageToolResult,
  generateImageSchema,
  sanitizeImageArtifactFileBase,
} from "../src/index";

test("image schema rejects malformed inputs", () => {
  assert.equal(
    generateImageSchema.safeParse({ prompt: "Draw a launch image" }).success,
    true,
  );
  assert.equal(generateImageSchema.safeParse({ prompt: "   " }).success, false);
  assert.equal(
    generateImageSchema.safeParse({
      prompt: "Draw a launch image",
      title: "x".repeat(161),
    }).success,
    false,
  );
});

test("image prompt and result helpers preserve backend behavior", () => {
  const lines = buildImageRuntimePromptLines({
    toolName: "generate_image",
    config: { aspectRatio: "16:9", quality: "high", style: "natural" },
  });

  assert.equal(
    lines.some((line) => line.includes("aspect_ratio=16:9")),
    true,
  );
  assert.equal(
    sanitizeImageArtifactFileBase("Q4 / Board: Review?"),
    "q4-board-review",
  );
  assert.equal(sanitizeImageArtifactFileBase("   "), "generated-image");
  assert.equal(
    buildArtifactPreviewUrl({
      artifactId: "artifact 1",
      workspaceId: "workspace 1",
    }),
    "/artifact-preview?artifactId=artifact+1&workspaceId=workspace+1",
  );

  const result = buildImageToolResult({
    artifactId: "artifact-1",
    artifactUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    config: { aspectRatio: "4:3", quality: "standard", style: "vivid" },
    height: 768,
    provider: "openai",
    providerModel: "gpt-image-1",
    title: "Launch Image",
    versionId: "version-1",
    width: 1024,
  });

  assert.equal(
    result,
    [
      "Image artifact created.",
      "artifact_id: artifact-1",
      "version_id: version-1",
      "title: Launch Image",
      "artifact_url: /artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      "aspect_ratio: 4:3",
      "width: 1024",
      "height: 768",
      "quality: standard",
      "style: vivid",
      "provider: openai",
      "provider_model: gpt-image-1",
      "The application will display the generated image automatically. Do not include image markdown or repeat raw URLs.",
    ].join("\n"),
  );
  assert.doesNotMatch(result, /!\[\]\(/u);
});

test("generate_image runtime persists image artifacts through the shared publisher core", async () => {
  const generatedBytes = Buffer.from("generated-png");
  const progressEvents: unknown[] = [];
  const storageUploads: unknown[] = [];
  const artifactRecords: unknown[] = [];
  const billingEvents: unknown[] = [];
  const imageTool = createGenerateImageTool(
    {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
      traceId: "trace-1",
      parentSpanId: "span-1",
      profile: {
        gatewayConfigId: "gateway-1",
        profileAlias: "image-default",
        modelAlias: "gpt-image-1",
      },
      config: {
        aspectRatio: "1:1",
        quality: "standard",
        style: "cartoon",
      },
    },
    {
      modelGateway: {
        images: {
          generate: async (request, opts) => {
            assert.equal(request.model, "image-default");
            assert.equal(request.responseFormat, "b64_json");
            assert.equal(opts?.traceId, "trace-1");
            // The billing identity must be present on the call itself: the
            // gateway settles here, so the key has to exist now rather than
            // being derived from the artifact published afterwards.
            billingEvents.push(opts);
            return {
              model: "gpt-image-1",
              provider: "openai",
              providerModel: "gpt-image-1",
              routeDecision: {
                alias: "image-default",
                mode: "GLOBAL",
                provider: "openai",
                providerKind: "openai",
                strategy: "priority",
              },
              usage: { totalTokens: 12 },
              images: [
                {
                  b64Json: generatedBytes.toString("base64"),
                  mimeType: "image/png",
                  revisedPrompt: "A revised prompt",
                  width: 1024,
                  height: 1024,
                },
              ],
              raw: {
                model: "gpt-image-1",
              },
            };
          },
        },
      },
      storage: {
        buildStorageKey: (input) =>
          `artifacts/${input.workspaceId}/${input.artifactId}/${input.fileName}`,
        getBucketName: () => "content",
        upload: async (input) => {
          storageUploads.push(input);
        },
      },
      artifacts: {
        createRecord: async (input) => {
          artifactRecords.push(input);
          return {
            artifactId: input.artifactId,
            versionId: "version-1",
          };
        },
      },
    },
  );

  const output = await imageTool.invoke(
    {
      prompt: "Draw a launch image",
      title: "Launch Image",
    },
    {
      toolCallId: "tool-call-1",
      writer: (event: unknown) => {
        progressEvents.push(event);
      },
    } as never,
  );

  const record = artifactRecords[0] as {
    artifactId: string;
    payload: {
      artifactType: string;
      source: { kind: string; tool: string };
      storageKey: string;
      toolCallId: string;
      prompt: string;
      provider: string;
    };
    storageBucket: string;
    storageKey: string;
  };
  assert.equal(record.storageBucket, "content");
  assert.equal(record.payload.artifactType, "image");
  assert.equal(record.payload.source.kind, "generated_image");
  assert.equal(record.payload.source.tool, "generate_image");
  assert.equal(record.payload.toolCallId, "tool-call-1");
  assert.equal(record.payload.prompt, "Draw a launch image");
  assert.equal(record.payload.provider, "openai");
  assert.match(record.storageKey, /launch-image\.png$/u);
  assert.equal(record.payload.storageKey, record.storageKey);

  const upload = storageUploads[0] as {
    body: Buffer;
    contentType: string;
    key: string;
  };
  assert.equal(upload.key, record.storageKey);
  assert.equal(upload.contentType, "image/png");
  assert.equal(upload.body.toString(), generatedBytes.toString());

  // Keys are pinned to the pre-allocated id, and that same id is what the
  // artifact was published under — so a retry replays instead of charging
  // twice, and a failure after generating still bills the tokens it burned.
  assert.equal(billingEvents.length, 1);
  const billing = billingEvents[0] as {
    idempotencyKey: string;
    referenceId: string;
    operation: string;
    modelKind: string;
  };
  assert.equal(billing.referenceId, `artifact:${record.artifactId}`);
  assert.equal(billing.idempotencyKey, `artifact-image:${record.artifactId}`);
  assert.equal(billing.operation, "images.generate");
  assert.equal(billing.modelKind, "image");
  assert.match(String(output), /Image artifact created\./u);
  assert.match(String(output), new RegExp(`artifact_id: ${record.artifactId}`, "u"));
  assert.equal(progressEvents.length, 5);
});
