import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withAgentToolHostInvocationSignal } from "@sourceweft/contracts/agent-tools";
import {
  DECK_VISUAL_QA_ISSUE_TYPES,
  aggregateDeckFindings,
  buildDeckVisualQaJudgePrompt,
  createCapabilityAgentTools,
  parseDeckVisualQaVerdicts,
  REVIEW_DECK_VISUALS_TOOL_NAME,
  summarizeDeckVerdicts,
} from "../src";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("judge prompt names every rubric issue type and the wire shape", () => {
  const prompt = buildDeckVisualQaJudgePrompt({ slideNumbers: [1, 2, 3] });
  for (const type of DECK_VISUAL_QA_ISSUE_TYPES) {
    assert.ok(prompt.includes(`- ${type}:`), `prompt is missing ${type}`);
  }
  assert.ok(prompt.includes("slides: 1, 2, 3"));
  assert.ok(prompt.includes('{"verdicts":'));
});

test("verdict parsing accepts plain and fenced JSON, rejects garbage", () => {
  const payload = JSON.stringify({
    verdicts: [
      {
        slideNumber: 2,
        ok: false,
        issues: [
          {
            type: "text_cutoff",
            severity: "severe",
            description: "Title clipped at the right edge.",
          },
        ],
      },
    ],
  });
  assert.equal(parseDeckVisualQaVerdicts(payload)?.length, 1);
  assert.equal(
    parseDeckVisualQaVerdicts("```json\n" + payload + "\n```")?.length,
    1,
  );
  assert.equal(parseDeckVisualQaVerdicts("not json at all"), null);
  assert.equal(
    parseDeckVisualQaVerdicts(
      JSON.stringify({
        verdicts: [{ slideNumber: 1, ok: true, issues: [{ type: "made_up" }] }],
      }),
    ),
    null,
  );
});

test("deck findings aggregate bullet_only majority and repeated layouts", () => {
  const bulletIssue = {
    type: "bullet_only" as const,
    severity: "minor" as const,
    description: "Title plus bullets only.",
  };
  const repeatIssue = {
    type: "repeated_layout" as const,
    severity: "minor" as const,
    description: "Same layout as prior slides.",
  };
  const verdicts = [
    { slideNumber: 1, ok: false, issues: [bulletIssue] },
    { slideNumber: 2, ok: false, issues: [bulletIssue, repeatIssue] },
    { slideNumber: 3, ok: true, issues: [] },
    { slideNumber: 4, ok: false, issues: [repeatIssue] },
  ];
  const findings = aggregateDeckFindings(verdicts);
  assert.equal(findings.length, 1, "bullet_only is not a majority of 4");
  assert.match(findings[0]!, /Layout monotony/);

  const majority = aggregateDeckFindings(verdicts.slice(0, 3));
  assert.equal(majority.length, 1);
  assert.match(majority[0]!, /Deck reads as a document/);

  assert.deepEqual(summarizeDeckVerdicts(verdicts), {
    severeCount: 0,
    minorCount: 4,
  });
  assert.deepEqual(aggregateDeckFindings([]), []);
});

test("SKILL.md and the manifest agree with the tool contract", async () => {
  const skillMd = await readFile(join(packageRoot, "SKILL.md"), "utf8");
  assert.ok(
    skillMd.includes("review_deck_visuals"),
    "SKILL.md never tells the agent to call review_deck_visuals",
  );
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "sourceweft.capability.json"), "utf8"),
  ) as { skills: Array<{ runtime?: { tools?: string[] } }> };
  assert.ok(
    manifest.skills[0]?.runtime?.tools?.includes("review_deck_visuals"),
    "manifest runtime.tools does not declare review_deck_visuals",
  );
});

test("review_deck_visuals forwards the invocation signal and stops later batches after abort", async () => {
  const controller = new AbortController();
  const abortReason = new DOMException("user stopped", "AbortError");
  let releaseVision!: () => void;
  let visionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    visionStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseVision = resolve;
  });
  const observedSignals: Array<AbortSignal | undefined> = [];
  let visionCalls = 0;
  const result = createCapabilityAgentTools({
    toolIds: [REVIEW_DECK_VISUALS_TOOL_NAME],
    context: {
      threadId: "thread-1",
      userMessageId: "message-1",
      turnState: {
        [REVIEW_DECK_VISUALS_TOOL_NAME]: {
          visionProfile: {
            gatewayConfigId: "gateway-1",
            profileAlias: "vision-default",
            modelAlias: "vision-model",
          },
        },
      },
    },
    services: {
      sandbox: {
        allowedReadRoots: ["/workspace"],
        downloadCurrentFile: async () => new Uint8Array([1, 2, 3]),
      },
      modelGateway: {
        getClient: async () => ({
          chat: {
            complete: async (
              _request: unknown,
              options: { signal?: AbortSignal },
            ) => {
              visionCalls += 1;
              observedSignals.push(options.signal);
              visionStarted();
              await blocked;
              return {
                raw: {
                  content: JSON.stringify({
                    verdicts: [{ slideNumber: 1, ok: true, issues: [] }],
                  }),
                },
              };
            },
          },
        }),
      },
    },
  } as never);
  const review = result.tools[0]?.tool;
  assert.ok(review);

  const invocation = review.invoke(
    {
      imagePaths: Array.from(
        { length: 9 },
        (_, index) => `/workspace/slide-${index + 1}.png`,
      ),
    },
    withAgentToolHostInvocationSignal(
      { toolCall: { id: "review-call-1" } },
      controller.signal,
    ) as never,
  );
  await started;
  controller.abort(abortReason);
  releaseVision();

  await assert.rejects(invocation, (error: unknown) => error === abortReason);
  assert.deepEqual(observedSignals, [controller.signal]);
  assert.equal(visionCalls, 1);
});

test("review_deck_visuals waits for sandbox download cancellation cleanup and never starts vision", async () => {
  const controller = new AbortController();
  const abortReason = new DOMException("user stopped", "AbortError");
  let downloadStarted!: () => void;
  let cleanupStarted!: () => void;
  let releaseCleanup!: () => void;
  const started = new Promise<void>((resolve) => {
    downloadStarted = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const cleanupRelease = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  let visionCalls = 0;
  const result = createCapabilityAgentTools({
    toolIds: [REVIEW_DECK_VISUALS_TOOL_NAME],
    context: {
      threadId: "thread-1",
      userMessageId: "message-1",
      turnState: {
        [REVIEW_DECK_VISUALS_TOOL_NAME]: {
          visionProfile: {
            gatewayConfigId: "gateway-1",
            profileAlias: "vision-default",
            modelAlias: "vision-model",
          },
        },
      },
    },
    services: {
      sandbox: {
        allowedReadRoots: ["/workspace"],
        downloadCurrentFile: async (input: { signal?: AbortSignal }) => {
          observedSignal = input.signal;
          downloadStarted();
          assert.ok(input.signal);
          await new Promise<void>((resolve) =>
            input.signal!.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          cleanupStarted();
          await cleanupRelease;
          throw input.signal.reason;
        },
      },
      modelGateway: {
        getClient: async () => ({
          chat: {
            complete: async () => {
              visionCalls += 1;
              return { raw: { content: "" } };
            },
          },
        }),
      },
    },
  } as never);
  const review = result.tools[0]?.tool;
  assert.ok(review);

  const invocation = review.invoke(
    { imagePaths: ["/workspace/slide-1.png"] },
    withAgentToolHostInvocationSignal(
      { toolCall: { id: "review-call-download-abort" } },
      controller.signal,
    ) as never,
  );
  await started;
  controller.abort(abortReason);
  await cleanup;

  let settled = false;
  void invocation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(observedSignal, controller.signal);
  assert.equal(visionCalls, 0);

  releaseCleanup();
  await assert.rejects(invocation, (error: unknown) => error === abortReason);
  assert.equal(visionCalls, 0);
});

test("review_deck_visuals never downgrades unconfirmed sandbox termination", async () => {
  const terminationUnknown = Object.assign(
    new Error("provider could not confirm sandbox termination"),
    { code: "SANDBOX_TERMINATION_UNKNOWN" },
  );
  let visionCalls = 0;
  const result = createCapabilityAgentTools({
    toolIds: [REVIEW_DECK_VISUALS_TOOL_NAME],
    context: {
      threadId: "thread-1",
      userMessageId: "message-1",
      turnState: {
        [REVIEW_DECK_VISUALS_TOOL_NAME]: {
          visionProfile: {
            gatewayConfigId: "gateway-1",
            profileAlias: "vision-default",
            modelAlias: "vision-model",
          },
        },
      },
    },
    services: {
      sandbox: {
        allowedReadRoots: ["/workspace"],
        downloadCurrentFile: async () => {
          throw terminationUnknown;
        },
      },
      modelGateway: {
        getClient: async () => ({
          chat: {
            complete: async () => {
              visionCalls += 1;
              return { raw: { content: "" } };
            },
          },
        }),
      },
    },
  } as never);
  const review = result.tools[0]?.tool;
  assert.ok(review);

  await assert.rejects(
    review.invoke({ imagePaths: ["/workspace/slide-1.png"] }, {
      toolCall: { id: "review-call-termination-unknown" },
    } as never),
    (error: unknown) => error === terminationUnknown,
  );
  assert.equal(visionCalls, 0);
});

test("PPT review forwards resolved BYOK execution and explicitly disables thinking for JSON review", async () => {
  const calls: Array<{
    request: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const execution = {
    executionMode: "BYOK",
    providerModel: "private-vision",
    credentialId: "credential-1",
    byokModelId: "model-1",
    byok: { provider: "custom", apiKey: "owned-key" },
  };
  const factory = createCapabilityAgentTools({
    context: {
      turnState: {
        [REVIEW_DECK_VISUALS_TOOL_NAME]: {
          visionProfile: {
            gatewayConfigId: "",
            profileAlias: "byok:vision:model-1",
            modelAlias: "private-vision",
          },
          execution,
        },
      },
    },
    services: {
      sandbox: {
        allowedReadRoots: ["/workspace"],
        downloadCurrentFile: async () => Buffer.from("image"),
      },
      modelGateway: {
        getClient: async () => ({
          chat: {
            complete: async (
              request: Record<string, unknown>,
              options: Record<string, unknown>,
            ) => {
              calls.push({ request, options });
              return {
                raw: {
                  content: JSON.stringify({
                    verdicts: [{ slideNumber: 1, ok: true, issues: [] }],
                  }),
                },
              };
            },
          },
        }),
      },
    },
  } as never);
  const result = JSON.parse(
    (await factory.tools[0]!.tool.invoke({
      imagePaths: ["/workspace/slide-1.jpg"],
    })) as string,
  );
  assert.equal(result.passed, true);
  assert.deepEqual(calls[0]!.request.thinking, { mode: "off" });
  assert.deepEqual(calls[0]!.options.llm, {
    ...execution,
    thinking: { mode: "off" },
  });
});

test("PPT review cannot pass when the judge omits requested slides", async () => {
  const factory = createCapabilityAgentTools({
    context: {
      turnState: {
        [REVIEW_DECK_VISUALS_TOOL_NAME]: {
          visionProfile: {
            gatewayConfigId: "global",
            profileAlias: "vision",
            modelAlias: "vision",
          },
        },
      },
    },
    services: {
      sandbox: {
        allowedReadRoots: ["/workspace"],
        downloadCurrentFile: async () => Buffer.from("image"),
      },
      modelGateway: {
        getClient: async () => ({
          chat: {
            complete: async () => ({
              raw: {
                content:
                  '{"verdicts":[{"slideNumber":1,"ok":true,"issues":[]}]}',
              },
            }),
          },
        }),
      },
    },
  } as never);
  const result = JSON.parse(
    (await factory.tools[0]!.tool.invoke({
      imagePaths: ["/workspace/slide-1.jpg", "/workspace/slide-2.jpg"],
    })) as string,
  );
  assert.equal(result.passed, false);
  assert.equal(result.skipped, true);
});
