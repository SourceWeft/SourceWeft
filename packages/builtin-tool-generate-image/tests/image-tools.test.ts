import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArtifactPreviewUrl,
  createGenerateImageTool,
  buildImageRuntimePromptLines,
  buildImageToolResult,
  generateImageSchema,
  generatedImageProvenance,
  GeneratedImageProvenanceSchema,
  imageFileExtensionForMimeType,
  sanitizeImageArtifactFileBase,
} from "../src/index";
import type { ImageToolContext, ImageToolRuntimeDeps } from "../src/index";
import { ARTIFACT_LIMITS } from "@sourceweft/contracts/artifact-files";
import type { ArtifactPublishSpec } from "@sourceweft/contracts/artifact-write";

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
    // Case and unicode are preserved now that image naming shares the
    // artifact-wide rule; this used to lowercase to "Q4-Board-Review".
    sanitizeImageArtifactFileBase("Q4 / Board: Review?"),
    "Q4-Board-Review",
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

type PublishCall = {
  artifactId?: string;
  context: {
    teamId: string;
    workspaceId: string;
    threadId: string;
    userId: string;
  };
  spec: ArtifactPublishSpec;
};

const CONTEXT: ImageToolContext = {
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
};

/**
 * The tool with a fake gateway and a fake writer.
 *
 * The writer is the only artifact dependency left: object storage, artifact
 * rows and file naming for the stored object are all behind
 * `publishArtifact` now, so what this package is responsible for — and all a
 * test here can observe — is the spec it hands over.
 */
function createImageToolHarness(
  options: {
    readonly bytes?: Buffer;
    readonly mimeType?: string;
    /**
     * Providers may hand back a URL instead of inline base64. It is also the
     * only way to deliver zero bytes: an empty `b64Json` is falsy, so the
     * decoder treats it as "no inline image" and follows the URL.
     */
    readonly deliverVia?: "b64" | "url";
  } = {},
) {
  const generatedBytes = options.bytes ?? Buffer.from("generated-png");
  const mimeType = options.mimeType ?? "image/png";
  const imagePayload =
    options.deliverVia === "url"
      ? { url: "https://images.test/generated", mimeType }
      : { b64Json: generatedBytes.toString("base64"), mimeType };
  if (options.deliverVia === "url") {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => mimeType },
      arrayBuffer: async () =>
        generatedBytes.buffer.slice(
          generatedBytes.byteOffset,
          generatedBytes.byteOffset + generatedBytes.byteLength,
        ),
    })) as unknown as typeof fetch;
  }
  const progressEvents: unknown[] = [];
  const billingEvents: unknown[] = [];
  const published: PublishCall[] = [];

  const deps: ImageToolRuntimeDeps = {
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
                ...imagePayload,
                revisedPrompt: "A revised prompt",
                width: 1024,
                height: 1024,
              },
            ],
            raw: { model: "gpt-image-1" },
          };
        },
      },
    },
    artifacts: {
      publishArtifact: async (input) => {
        published.push(input as PublishCall);
        return {
          artifactId: input.artifactId ?? "artifact-1",
          versionId: "version-1",
          reused: false,
        };
      },
    },
  };

  const imageTool = createGenerateImageTool(CONTEXT, deps);

  return {
    billingEvents,
    generatedBytes,
    progressEvents,
    published,
    invoke: (args: { prompt: string; title?: string }) =>
      imageTool.invoke(args, {
        toolCallId: "tool-call-1",
        writer: (event: unknown) => {
          progressEvents.push(event);
        },
      } as never),
  };
}

test("generate_image publishes through the shared artifact writer", async () => {
  const harness = createImageToolHarness();
  const output = await harness.invoke({
    prompt: "Draw a launch image",
    title: "Launch Image",
  });

  assert.equal(harness.published.length, 1);
  const call = harness.published[0]!;
  assert.deepEqual(call.context, {
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
  });
  assert.equal(call.spec.artifactType, "image");
  assert.equal(call.spec.title, "Launch Image");
  // prompt_text on the row: the old path passed descriptor.description, which
  // was the prompt, and the writer falls back to the title only without one.
  assert.equal(call.spec.prompt, "Draw a launch image");
  // No idempotency key: generate_image keys billing on the pre-allocated id,
  // and asking the writer to reuse a ready artifact would change what a retry
  // means.
  assert.equal(call.spec.idempotency, undefined);
  // No thumbnail is produced today. The writer would accept one for any type —
  // the "previewImage is only supported for slides" rule is no longer on this
  // path — so the row keeps preview_storage_key NULL and preview_metadata {}.
  assert.equal(call.spec.preview, undefined);

  assert.match(String(output), /Image artifact created\./u);
  assert.match(String(output), /version_id: version-1/u);
  assert.match(
    String(output),
    /artifact_url: \/artifact-preview\?artifactId=/u,
  );
  assert.equal(harness.progressEvents.length, 5);

  // Keys are pinned to the pre-allocated id, and that same id is what the
  // artifact was published under — so a retry replays instead of charging
  // twice, and a failure after generating still bills the tokens it burned.
  assert.equal(harness.billingEvents.length, 1);
  const billing = harness.billingEvents[0] as {
    idempotencyKey: string;
    referenceId: string;
    operation: string;
    modelKind: string;
  };
  assert.equal(billing.referenceId, `artifact:${call.artifactId}`);
  assert.equal(billing.idempotencyKey, `artifact-image:${call.artifactId}`);
  assert.equal(billing.operation, "images.generate");
  assert.equal(billing.modelKind, "image");
  assert.match(
    String(output),
    new RegExp(`artifact_id: ${call.artifactId}`, "u"),
  );
});

test("the published payload reproduces the row the old publisher wrote", async () => {
  const harness = createImageToolHarness();
  await harness.invoke({
    prompt: "Draw a launch image",
    title: "Launch Image",
  });
  const spec = harness.published[0]!.spec;

  // Field for field what publishPreparedArtifact used to persist for an image:
  // the image type handler's fields, plus the generation metadata the tool
  // supplied, plus toolCallId. `image` has no write handler — by design, since
  // it has two producers — so nothing shapes this payload after the fact and
  // deepEqual here is the whole persisted payload_json.
  assert.deepEqual(spec.payload, {
    artifactType: "image",
    byteLength: harness.generatedBytes.byteLength,
    description: "Draw a launch image",
    fileName: "Launch-Image.png",
    mimeType: "image/png",
    source: { kind: "generated_image", tool: "generate_image" },
    title: "Launch Image",
    prompt: "Draw a launch image",
    config: { aspectRatio: "1:1", quality: "standard", style: "cartoon" },
    sizeBytes: harness.generatedBytes.byteLength,
    provider: "openai",
    providerModel: "gpt-image-1",
    routeDecision: {
      alias: "image-default",
      mode: "GLOBAL",
      provider: "openai",
      providerKind: "openai",
      strategy: "priority",
    },
    revisedPrompt: "A revised prompt",
    width: 1024,
    height: 1024,
    toolCallId: "tool-call-1",
  });
  // The one deliberate omission. The old publisher copied the object key into
  // the payload after uploading; the real key embeds a random UUID the caller
  // cannot predict, and the writer commits the payload in the same transaction
  // that sets the column. It has no readers — every consumer reads the row's
  // own storage_key — so the copy is gone rather than reconstructed.
  assert.equal("storageKey" in spec.payload, false);

  // The bytes are the artifact's own file: exactly one primary attachment,
  // which is what gives the row its storage_bucket / storage_key.
  assert.equal(spec.attachments?.length, 1);
  const attachment = spec.attachments![0]!;
  assert.equal(attachment.role, "primary");
  assert.equal(attachment.fileName, "Launch-Image.png");
  assert.equal(attachment.contentType, "image/png");
  assert.equal(
    Buffer.from(attachment.bytes).toString(),
    harness.generatedBytes.toString(),
  );
});

test("the attachment file name follows the provider's real mime type", async () => {
  for (const [mimeType, expected] of [
    ["image/png", "Launch-Image.png"],
    ["image/jpeg", "Launch-Image.jpg"],
    ["image/webp", "Launch-Image.webp"],
  ] as const) {
    const harness = createImageToolHarness({ mimeType });
    await harness.invoke({
      prompt: "Draw a launch image",
      title: "Launch Image",
    });
    const spec = harness.published[0]!.spec;
    assert.equal(spec.attachments?.[0]?.fileName, expected);
    assert.equal(spec.attachments?.[0]?.contentType, mimeType);
    assert.equal(spec.payload.fileName, expected);
    assert.equal(spec.payload.mimeType, mimeType);
  }
});

test("image content rules keep their original error codes", async () => {
  // These three ran inside the old publisher's image type handler. They are
  // enforced here now, and the codes are unchanged: they are a wire contract,
  // so an oversized image must not start reporting the writer's own
  // ARTIFACT_ATTACHMENT_TOO_LARGE.
  const empty = createImageToolHarness({
    bytes: Buffer.alloc(0),
    deliverVia: "url",
  });
  await assert.rejects(
    empty.invoke({ prompt: "Draw a launch image", title: "Launch Image" }),
    (error: Error & { code?: string; recoverable?: boolean }) => {
      assert.equal(error.code, "ARTIFACT_FILE_EMPTY");
      assert.equal(error.message, "ARTIFACT_FILE_EMPTY: file is empty");
      assert.equal(error.recoverable, true);
      return true;
    },
  );
  assert.deepEqual(empty.published, []);

  const oversized = createImageToolHarness({
    bytes: Buffer.alloc(ARTIFACT_LIMITS.imageBytes + 1),
    deliverVia: "url",
  });
  await assert.rejects(
    oversized.invoke({ prompt: "Draw a launch image", title: "Launch Image" }),
    (error: Error & { code?: string; recoverable?: boolean }) => {
      assert.equal(error.code, "ARTIFACT_FILE_TOO_LARGE");
      assert.equal(
        error.message,
        `ARTIFACT_FILE_TOO_LARGE: ${ARTIFACT_LIMITS.imageBytes + 1} bytes exceeds limit of ${ARTIFACT_LIMITS.imageBytes} bytes`,
      );
      assert.equal(error.recoverable, true);
      return true;
    },
  );
  assert.deepEqual(oversized.published, []);

  const wrongType = createImageToolHarness({ mimeType: "image/gif" });
  await assert.rejects(
    wrongType.invoke({ prompt: "Draw a launch image", title: "Launch Image" }),
    (error: Error & { code?: string; recoverable?: boolean }) => {
      assert.equal(error.code, "ARTIFACT_SOURCE_INVALID");
      assert.equal(
        error.message,
        "ARTIFACT_SOURCE_INVALID: expected image MIME type, received image/gif",
      );
      assert.equal(error.recoverable, true);
      return true;
    },
  );
  assert.deepEqual(wrongType.published, []);
});

test("payload.source is provenance, validated by its own schema", () => {
  // Not ArtifactSourceSchema: that union describes where bytes are read from
  // (sandbox_path | work_file, both with a path) and is consumed by
  // adapterForSource. A generated image has no path. This value used to be an
  // unvalidated literal that only survived because its entry point skipped the
  // zod parse.
  assert.deepEqual(generatedImageProvenance("generate_image"), {
    kind: "generated_image",
    tool: "generate_image",
  });
  assert.equal(
    GeneratedImageProvenanceSchema.safeParse({
      kind: "sandbox_path",
      tool: "generate_image",
    }).success,
    false,
  );
  assert.equal(
    GeneratedImageProvenanceSchema.safeParse({
      kind: "generated_image",
      tool: "",
    }).success,
    false,
  );
});

test("generated image file names follow the provider's actual mime type", () => {
  assert.equal(imageFileExtensionForMimeType("image/jpeg"), ".jpg");
  assert.equal(imageFileExtensionForMimeType("image/webp"), ".webp");
  assert.equal(imageFileExtensionForMimeType("image/PNG"), ".png");
  // Content-Type headers routinely carry parameters.
  assert.equal(imageFileExtensionForMimeType("image/jpeg; charset=binary"), ".jpg");
  // Unknown/absent types keep the historical default rather than producing ".bin".
  assert.equal(imageFileExtensionForMimeType("application/octet-stream"), ".png");
  assert.equal(imageFileExtensionForMimeType(undefined), ".png");
});
