import assert from "node:assert/strict";
import test from "node:test";
import { createGenerateVideoAssetsTool } from "../src/agent/asset-tool";
import { createGenerateVideoNarrationTool } from "../src/agent/narration-tool";
import { sha256Digest, videoModelSemanticIdentity } from "../src/agent/common";
import { ModelGatewayError } from "@sourceweft/model-gateway";
import { withAgentToolHostInvocationSignal } from "@sourceweft/contracts/agent-tools";

const profile = {
  gatewayConfigId: "gateway-1",
  profileAlias: "profile-default",
  modelAlias: "model-default",
};

test("asset batch claims before provider work and stages WIP without an artifact", async () => {
  const events: string[] = [];
  const uploaded: Array<{ path: string; bytes: Uint8Array }> = [];
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const assetTool = createGenerateVideoAssetsTool({
    profile,
    traceId: "trace-1",
    services: {
      operationCache: {
        claimMany: async (input) => {
          events.push("claim");
          return {
            kind: "claimed",
            items: input.semanticKeys.map((semanticKey) => ({
              semanticKey,
              action: "execute" as const,
              claimToken: "asset-claim",
            })),
          };
        },
        complete: async () => {
          events.push("complete");
          return { observationId: "asset-observation" };
        },
        markUnknown: async () => undefined,
      },
      modelGateway: {
        getClient: async () =>
          ({
            images: {
              generate: async (request: Record<string, unknown>) => {
                events.push("provider");
                assert.equal(request.fallbackPolicy, "none");
                return {
                  model: "image-model",
                  provider: "provider-a",
                  providerModel: "resolved-image",
                  images: [
                    {
                      b64Json: Buffer.from(bytes).toString("base64"),
                      mimeType: "image/png",
                      width: 1024,
                      height: 1024,
                    },
                  ],
                  raw: {},
                };
              },
            },
          }) as never,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async (files) => {
          uploaded.push(...files);
          events.push("upload");
        },
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      workBlobs: {
        putIfAbsent: async (input) => {
          events.push("wip");
          assert.equal(input.contentDigest, sha256Digest(bytes));
          return { blobRef: "wip-asset", contentDigest: input.contentDigest };
        },
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });

  const output = (await assetTool.invoke(
    {
      projectRoot: "/workspace/video",
      assets: [
        {
          assetId: "hero",
          prompt: "A technical hero visual",
          type: "hero",
          slideNumbers: [1],
        },
      ],
    },
    { toolCallId: "asset-call" } as never,
  )) as { status: string; assets: Array<{ sandboxPath: string }> };

  assert.equal(output.status, "succeeded");
  assert.match(output.assets[0]!.sandboxPath, /public\/assets\/hero\.png$/u);
  assert.deepEqual(events, ["claim", "provider", "wip", "complete", "upload"]);
  assert.deepEqual(uploaded[0]?.bytes, bytes);
});

test("narration stores bytes before probing and records measured duration", async () => {
  const events: string[] = [];
  const audio = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
  const narrationTool = createGenerateVideoNarrationTool({
    profile: { ...profile, modelAlias: "tts-default" },
    services: {
      operationCache: {
        claimMany: async (input) => {
          events.push("claim");
          return {
            kind: "claimed",
            items: input.semanticKeys.map((semanticKey) => ({
              semanticKey,
              action: "execute" as const,
              claimToken: "narration-claim",
            })),
          };
        },
        complete: async () => {
          events.push("complete");
          return { observationId: "narration-observation" };
        },
        markUnknown: async () => undefined,
      },
      media: {
        probeAudioDurationSeconds: async () => {
          events.push("probe");
          return 2.5;
        },
      },
      modelGateway: {
        getClient: async () =>
          ({
            tts: {
              speech: async (request: Record<string, unknown>) => {
                events.push("provider");
                assert.equal(request.fallbackPolicy, "none");
                return {
                  model: "tts-model",
                  provider: "provider-a",
                  providerModel: "resolved-tts",
                  audio: audio.buffer,
                  mimeType: "audio/mpeg",
                  raw: {},
                };
              },
            },
          }) as never,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => {
          events.push("upload");
        },
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      workBlobs: {
        putIfAbsent: async (input) => {
          events.push("wip");
          return {
            blobRef: "wip-audio",
            contentDigest: input.contentDigest,
          };
        },
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });

  const output = (await narrationTool.invoke(
    {
      projectRoot: "/workspace/video",
      tracks: [{ slideNumber: 1, text: "Narrate slide one." }],
    },
    { toolCallId: "narration-call" } as never,
  )) as { status: string; tracks: Array<{ durationSeconds: number }> };

  assert.equal(output.status, "succeeded");
  assert.equal(output.tracks[0]?.durationSeconds, 2.5);
  assert.deepEqual(events, [
    "claim",
    "provider",
    "wip",
    "probe",
    "complete",
    "upload",
  ]);
});

test("duplicate asset ids and slide numbers are rejected before claims or providers", async () => {
  let claims = 0;
  let clients = 0;
  const commonServices = {
    operationCache: {
      claimMany: async () => {
        claims += 1;
        return {
          kind: "unknown",
          code: "SIDE_EFFECT_OUTCOME_UNKNOWN",
        } as const;
      },
      complete: async () => ({ observationId: "unused" }),
      markUnknown: async () => undefined,
    },
    modelGateway: {
      getClient: async () => {
        clients += 1;
        return {} as never;
      },
    },
    sandbox: {
      allowedReadRoots: ["/workspace"],
      ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
      uploadCurrentFiles: async () => undefined,
      listCurrentFiles: async () => [],
      downloadCurrentFile: async () => new Uint8Array(),
      executeCurrent: async () => ({ exitCode: 0, output: "" }),
      captureCurrentTree: async () => [],
    },
    workBlobs: {
      putIfAbsent: async () => ({
        blobRef: "unused",
        contentDigest: "unused",
      }),
      getVerified: async () => null,
      getBySemanticKey: async () => null,
      deleteScope: async () => undefined,
    },
  };
  const assetTool = createGenerateVideoAssetsTool({
    profile,
    services: commonServices as never,
  });
  const assetOutput = (await assetTool.invoke(
    {
      projectRoot: "/workspace/video",
      assets: [
        {
          assetId: "hero",
          prompt: "First",
          type: "hero",
          slideNumbers: [1],
        },
        {
          assetId: "hero",
          prompt: "Second",
          type: "diagrammatic_visual",
          slideNumbers: [2],
        },
      ],
    },
    { toolCallId: "asset-duplicates" } as never,
  )) as Record<string, unknown>;
  assert.equal(assetOutput.code, "VIDEO_ASSET_DUPLICATE_ID");

  const narrationTool = createGenerateVideoNarrationTool({
    profile,
    services: {
      ...commonServices,
      media: { probeAudioDurationSeconds: async () => 1 },
    } as never,
  });
  const narrationOutput = (await narrationTool.invoke(
    {
      projectRoot: "/workspace/video",
      tracks: [
        { slideNumber: 1, text: "First" },
        { slideNumber: 1, text: "Second" },
      ],
    },
    { toolCallId: "narration-duplicates" } as never,
  )) as Record<string, unknown>;
  assert.equal(narrationOutput.code, "VIDEO_NARRATION_DUPLICATE_SLIDE");
  assert.equal(claims, 0);
  assert.equal(clients, 0);
});

test("cached successes are path-independent and restage under the current root", async () => {
  const uploaded: string[] = [];
  const bytes = new Uint8Array([1, 2, 3]);
  const assetTool = createGenerateVideoAssetsTool({
    profile,
    services: {
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "reuse",
              observationId: "asset-observation",
              observation: {
                status: "succeeded",
                assetId: "hero",
                blobRef: "asset-blob",
                contentDigest: sha256Digest(bytes),
                contentType: "image/png",
                fileName: "hero.png",
              },
            },
          ],
        }),
        complete: async () => ({ observationId: "unused" }),
        markUnknown: async () => undefined,
      },
      modelGateway: {
        getClient: async () => {
          throw new Error("cache reuse must not open a provider client");
        },
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({
          sessionGeneration: "new-session",
        }),
        uploadCurrentFiles: async (files) => {
          uploaded.push(...files.map((file) => file.path));
        },
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      workBlobs: {
        putIfAbsent: async () => ({
          blobRef: "unused",
          contentDigest: "unused",
        }),
        getVerified: async () => ({ bytes, contentType: "image/png" }),
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });

  const output = (await assetTool.invoke(
    {
      projectRoot: "/workspace/current-project",
      assets: [
        {
          assetId: "hero",
          prompt: "Hero",
          type: "hero",
          slideNumbers: [1],
        },
      ],
    },
    { toolCallId: "asset-reuse" } as never,
  )) as {
    status: string;
    assets: Array<{ sandboxPath: string }>;
  };
  assert.equal(output.status, "succeeded");
  assert.equal(
    output.assets[0]?.sandboxPath,
    "/workspace/current-project/public/assets/hero.png",
  );
  assert.deepEqual(uploaded, [
    "/workspace/current-project/public/assets/hero.png",
  ]);
});

test("BYOK image requests carry the resolved route and semantic key identity", async () => {
  const bytes = new Uint8Array([4, 5, 6]);
  const semanticKeys: string[] = [];
  const requests: Array<{
    request: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const execution = {
    executionMode: "BYOK" as const,
    providerModel: "provider/image-current",
    providerHint: "openrouter",
    byokModelId: "byok-image-1",
    credentialId: "credential-1",
    byok: {
      provider: "openrouter",
      providerKind: "openrouter",
      apiKey: "secret",
      baseUrl: "https://router.example/v1",
    },
  };
  const byokProfile = {
    gatewayConfigId: "",
    profileAlias: "byok:image:byok-image-1:credential-1",
    modelAlias: "provider/image-current",
  };
  const assetTool = createGenerateVideoAssetsTool({
    profile: byokProfile,
    execution,
    services: {
      operationCache: {
        claimMany: async (input) => {
          semanticKeys.push(...input.semanticKeys);
          return {
            kind: "claimed",
            items: input.semanticKeys.map((semanticKey) => ({
              semanticKey,
              action: "execute" as const,
              claimToken: "claim",
            })),
          };
        },
        complete: async () => ({ observationId: "observation" }),
        markUnknown: async () => undefined,
      },
      modelGateway: {
        getClient: async () =>
          ({
            images: {
              generate: async (
                request: Record<string, unknown>,
                options: Record<string, unknown>,
              ) => {
                requests.push({ request, options });
                return {
                  model: "provider/image-current",
                  images: [
                    {
                      b64Json: Buffer.from(bytes).toString("base64"),
                      mimeType: "image/png",
                    },
                  ],
                  raw: {},
                };
              },
            },
          }) as never,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      workBlobs: {
        putIfAbsent: async (input) => ({
          blobRef: "asset-blob",
          contentDigest: input.contentDigest,
        }),
        getVerified: async () => null,
        getBySemanticKey: async () => ({
          blobRef: "asset-blob",
          bytes,
          contentType: "image/png",
          contentDigest: sha256Digest(bytes),
        }),
        deleteScope: async () => undefined,
      },
    },
  });

  await assetTool.invoke(
    {
      projectRoot: "/workspace/video",
      assets: [
        {
          assetId: "hero",
          prompt: "BYOK hero",
          type: "hero",
          slideNumbers: [1],
        },
      ],
    },
    { toolCallId: "byok-asset" } as never,
  );

  assert.deepEqual(requests[0]?.request, {
    model: "provider/image-current",
    fallbackPolicy: "none",
    executionMode: "BYOK",
    providerHint: "openrouter",
    byokModelId: "byok-image-1",
    credentialId: "credential-1",
    byok: execution.byok,
    prompt: "BYOK hero",
    count: 1,
    responseFormat: "b64_json",
  });
  assert.deepEqual(requests[0]?.options.llm, execution);
  const expectedSemanticKey = sha256Digest(
    JSON.stringify({
      version: 2,
      provider: videoModelSemanticIdentity(byokProfile, execution),
      prompt: "BYOK hero",
      assetId: "hero",
      type: "hero",
    }),
  );
  assert.deepEqual(semanticKeys, [expectedSemanticKey]);
});

test("URL-only image responses terminate as known failure without fetching", async () => {
  let fetches = 0;
  let unknowns = 0;
  const completed: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("must not fetch provider URLs");
  }) as typeof fetch;
  try {
    const assetTool = createGenerateVideoAssetsTool({
      profile,
      services: {
        operationCache: {
          claimMany: async (input) => ({
            kind: "claimed",
            items: [
              {
                semanticKey: input.semanticKeys[0]!,
                action: "execute",
                claimToken: "claim",
              },
            ],
          }),
          complete: async (input) => {
            completed.push(input.observation);
            return { observationId: "failed-observation" };
          },
          markUnknown: async () => {
            unknowns += 1;
          },
        },
        modelGateway: {
          getClient: async () =>
            ({
              images: {
                generate: async () => ({
                  model: "model",
                  images: [{ url: "https://provider.example/image.png" }],
                  raw: {},
                }),
              },
            }) as never,
        },
        sandbox: {
          allowedReadRoots: ["/workspace"],
          ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
          uploadCurrentFiles: async () => undefined,
          listCurrentFiles: async () => [],
          downloadCurrentFile: async () => new Uint8Array(),
          executeCurrent: async () => ({ exitCode: 0, output: "" }),
          captureCurrentTree: async () => [],
        },
        workBlobs: {
          putIfAbsent: async () => ({
            blobRef: "unused",
            contentDigest: "unused",
          }),
          getVerified: async () => null,
          getBySemanticKey: async () => null,
          deleteScope: async () => undefined,
        },
      },
    });
    const output = (await assetTool.invoke(
      {
        projectRoot: "/workspace/video",
        assets: [
          {
            assetId: "hero",
            prompt: "URL hero",
            type: "hero",
            slideNumbers: [1],
          },
        ],
      },
      { toolCallId: "url-asset" } as never,
    )) as { status: string; diagnostics: Array<{ code: string }> };

    assert.equal(output.status, "failed");
    assert.equal(
      output.diagnostics[0]?.code,
      "VIDEO_ASSET_INLINE_BYTES_REQUIRED",
    );
    assert.deepEqual(completed, [
      {
        status: "failed",
        code: "VIDEO_ASSET_INLINE_BYTES_REQUIRED",
        message: "The image provider did not return inline bytes.",
      },
    ]);
    assert.equal(fetches, 0);
    assert.equal(unknowns, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("known gateway failures complete failed claims; timeouts become unknown", async () => {
  for (const testCase of [
    { gatewayCode: "BAD_REQUEST" as const, expectedKnown: true },
    { gatewayCode: "TIMEOUT" as const, expectedKnown: false },
  ]) {
    const completed: unknown[] = [];
    let unknowns = 0;
    const assetTool = createGenerateVideoAssetsTool({
      profile,
      services: {
        operationCache: {
          claimMany: async (input) => ({
            kind: "claimed",
            items: [
              {
                semanticKey: input.semanticKeys[0]!,
                action: "execute",
                claimToken: "claim",
              },
            ],
          }),
          complete: async (input) => {
            completed.push(input.observation);
            return { observationId: "observation" };
          },
          markUnknown: async () => {
            unknowns += 1;
          },
        },
        modelGateway: {
          getClient: async () =>
            ({
              images: {
                generate: async () => {
                  throw new ModelGatewayError({
                    code: testCase.gatewayCode,
                    message: "provider detail must not leak",
                  });
                },
              },
            }) as never,
        },
        sandbox: {
          allowedReadRoots: ["/workspace"],
          ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
          uploadCurrentFiles: async () => undefined,
          listCurrentFiles: async () => [],
          downloadCurrentFile: async () => new Uint8Array(),
          executeCurrent: async () => ({ exitCode: 0, output: "" }),
          captureCurrentTree: async () => [],
        },
        workBlobs: {
          putIfAbsent: async () => ({
            blobRef: "unused",
            contentDigest: "unused",
          }),
          getVerified: async () => null,
          getBySemanticKey: async () => null,
          deleteScope: async () => undefined,
        },
      },
    });
    const output = (await assetTool.invoke(
      {
        projectRoot: "/workspace/video",
        assets: [
          {
            assetId: `hero-${testCase.gatewayCode}`,
            prompt: "Failure",
            type: "hero",
            slideNumbers: [1],
          },
        ],
      },
      { toolCallId: `failure-${testCase.gatewayCode}` } as never,
    )) as { diagnostics: Array<{ code: string }> };

    if (testCase.expectedKnown) {
      assert.deepEqual(completed, [
        {
          status: "failed",
          code: "VIDEO_ASSET_PROVIDER_BAD_REQUEST",
          message: "The image provider rejected the request (BAD_REQUEST).",
        },
      ]);
      assert.equal(unknowns, 0);
      assert.equal(
        output.diagnostics[0]?.code,
        "VIDEO_ASSET_PROVIDER_BAD_REQUEST",
      );
    } else {
      assert.equal(completed.length, 0);
      assert.equal(unknowns, 1);
      assert.equal(
        output.diagnostics[0]?.code,
        "VIDEO_ASSET_PROVIDER_OUTCOME_UNKNOWN",
      );
    }
  }
});

test("cached narration restages by file name under the current project root", async () => {
  const audio = new Uint8Array([0x49, 0x44, 0x33, 1]);
  const uploaded: string[] = [];
  const narrationTool = createGenerateVideoNarrationTool({
    profile,
    services: {
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "reuse",
              observationId: "narration-observation",
              observation: {
                status: "succeeded",
                slideNumber: 1,
                blobRef: "audio-blob",
                contentDigest: sha256Digest(audio),
                contentType: "audio/mpeg",
                durationSeconds: 2,
                fileName: "slide-1.mp3",
              },
            },
          ],
        }),
        complete: async () => ({ observationId: "unused" }),
        markUnknown: async () => undefined,
      },
      media: { probeAudioDurationSeconds: async () => 2 },
      modelGateway: {
        getClient: async () => {
          throw new Error("cache reuse must not open a provider client");
        },
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({
          sessionGeneration: "new-session",
        }),
        uploadCurrentFiles: async (files) => {
          uploaded.push(...files.map((file) => file.path));
        },
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      workBlobs: {
        putIfAbsent: async () => ({
          blobRef: "unused",
          contentDigest: "unused",
        }),
        getVerified: async () => ({ bytes: audio, contentType: "audio/mpeg" }),
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });

  const output = (await narrationTool.invoke(
    {
      projectRoot: "/workspace/current-project",
      tracks: [{ slideNumber: 1, text: "Narration" }],
    },
    { toolCallId: "narration-reuse" } as never,
  )) as {
    status: string;
    tracks: Array<{ sandboxPath: string }>;
  };
  assert.equal(output.status, "succeeded");
  assert.equal(
    output.tracks[0]?.sandboxPath,
    "/workspace/current-project/public/audio/slide-1.mp3",
  );
  assert.deepEqual(uploaded, [
    "/workspace/current-project/public/audio/slide-1.mp3",
  ]);
});

test("BYOK narration is rejected before sandbox, cache, or provider access", async () => {
  const calls: string[] = [];
  const execution = {
    executionMode: "BYOK" as const,
    providerModel: "provider/tts-current",
    providerHint: "deepinfra",
    byokModelId: "byok-tts-1",
    credentialId: "credential-tts-1",
    byok: {
      provider: "deepinfra",
      providerKind: "deepinfra",
      apiKey: "secret",
    },
  };
  const narrationTool = createGenerateVideoNarrationTool({
    profile: {
      gatewayConfigId: "",
      profileAlias: "byok:tts:byok-tts-1:credential-tts-1",
      modelAlias: "provider/tts-current",
    },
    execution,
    services: {
      operationCache: {
        claimMany: async () => {
          calls.push("claim");
          return {
            kind: "unknown",
            code: "SIDE_EFFECT_OUTCOME_UNKNOWN",
          };
        },
        complete: async () => ({ observationId: "observation" }),
        markUnknown: async () => undefined,
      },
      media: {
        probeAudioDurationSeconds: async () => {
          calls.push("probe");
          return 2;
        },
      },
      modelGateway: {
        getClient: async () => {
          calls.push("provider");
          return {} as never;
        },
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => {
          calls.push("sandbox");
          return { sessionGeneration: "session" };
        },
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      workBlobs: {
        putIfAbsent: async (input) => ({
          blobRef: "audio-blob",
          contentDigest: input.contentDigest,
        }),
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });

  const output = (await narrationTool.invoke(
    {
      projectRoot: "/workspace/video",
      voice: "voice-a",
      tracks: [{ slideNumber: 1, text: "Narrate" }],
    },
    { toolCallId: "byok-narration" } as never,
  )) as { status: string; code: string };

  assert.equal(output.status, "blocked");
  assert.equal(output.code, "VIDEO_TTS_BYOK_UNSUPPORTED");
  assert.deepEqual(calls, []);
});

test("asset generation forwards cancellation and fences its execute claim as unknown", async () => {
  const controller = new AbortController();
  const abortReason = new Error("tool timed out");
  const unknownReasons: string[] = [];
  const assetTool = createGenerateVideoAssetsTool({
    profile,
    services: {
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "execute",
              claimToken: "asset-abort-claim",
            },
          ],
        }),
        complete: async () => {
          throw new Error("an aborted claim must not complete");
        },
        markUnknown: async (input) => {
          unknownReasons.push(input.reason);
        },
      },
      modelGateway: {
        getClient: async () =>
          ({
            images: {
              generate: async (
                _request: unknown,
                options: { signal?: AbortSignal },
              ) => {
                assert.equal(options.signal, controller.signal);
                controller.abort(abortReason);
                throw abortReason;
              },
            },
          }) as never,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      workBlobs: {
        putIfAbsent: async () => {
          throw new Error("aborted provider bytes must not be stored");
        },
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });

  await assert.rejects(
    assetTool.invoke(
      {
        projectRoot: "/workspace/video",
        assets: [
          {
            assetId: "hero-abort",
            prompt: "Abort this request",
            type: "hero",
            slideNumbers: [1],
          },
        ],
      },
      withAgentToolHostInvocationSignal(
        { toolCallId: "asset-abort" },
        controller.signal,
      ) as never,
    ),
    (error) => error === abortReason,
  );
  assert.deepEqual(unknownReasons, ["ASSET_TOOL_ABORTED"]);
});

test("narration generation forwards cancellation and fences its execute claim as unknown", async () => {
  const controller = new AbortController();
  const abortReason = new Error("tool timed out");
  const unknownReasons: string[] = [];
  const narrationTool = createGenerateVideoNarrationTool({
    profile: { ...profile, modelAlias: "tts-default" },
    services: {
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "execute",
              claimToken: "narration-abort-claim",
            },
          ],
        }),
        complete: async () => {
          throw new Error("an aborted claim must not complete");
        },
        markUnknown: async (input) => {
          unknownReasons.push(input.reason);
        },
      },
      media: {
        probeAudioDurationSeconds: async () => {
          throw new Error("aborted audio must not be probed");
        },
      },
      modelGateway: {
        getClient: async () =>
          ({
            tts: {
              speech: async (
                _request: unknown,
                options: { signal?: AbortSignal },
              ) => {
                assert.equal(options.signal, controller.signal);
                controller.abort(abortReason);
                throw abortReason;
              },
            },
          }) as never,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      workBlobs: {
        putIfAbsent: async () => {
          throw new Error("aborted provider bytes must not be stored");
        },
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });

  await assert.rejects(
    narrationTool.invoke(
      {
        projectRoot: "/workspace/video",
        tracks: [{ slideNumber: 1, text: "Abort this narration." }],
      },
      withAgentToolHostInvocationSignal(
        { toolCallId: "narration-abort" },
        controller.signal,
      ) as never,
    ),
    (error) => error === abortReason,
  );
  assert.deepEqual(unknownReasons, ["NARRATION_TOOL_ABORTED"]);
});
