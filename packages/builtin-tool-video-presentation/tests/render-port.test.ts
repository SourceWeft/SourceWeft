import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolSandboxServices } from "@sourceweft/contracts/agent-tools";
import {
  VIDEO_PRESENTATION_RENDER_POLICY,
  VideoPresentationRenderError,
  createSandboxVideoPresentationRenderPort,
  deriveVideoRenderBitrate,
  resolveVideoPresentationRenderPolicy,
  type VideoPresentationRenderPolicy,
} from "../src/agent/render-port";
import { sha256Digest } from "../src/agent/common";

function box(type: string, body = new Uint8Array()) {
  const bytes = new Uint8Array(8 + body.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(body, 8);
  return bytes;
}

function join(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

const fastStartMp4 = join(
  box("ftyp"),
  box("moov"),
  box("mdat", new Uint8Array([1])),
);

const project = {
  durationInFrames: 150,
  fps: 30,
  width: 1920,
  height: 1080,
  narrationEnabled: false,
  scenes: [
    { slideNumber: 1, durationInFrames: 60 },
    { slideNumber: 2, durationInFrames: 90 },
  ],
} as const;

const samples = [
  {
    slideNumber: 1,
    sampleId: "middle" as const,
    frame: 30,
    relativePath: "out/slide-1-middle.jpeg",
  },
  {
    slideNumber: 2,
    sampleId: "middle" as const,
    frame: 105,
    relativePath: "out/slide-2-middle.jpeg",
  },
];

function harness(options?: {
  failCommandIncludes?: string;
  failureOutput?: string;
  mp4?: Uint8Array;
  onCommand?: (command: string) => void;
  onAbortedCommand?: (signal: AbortSignal) => Promise<void>;
  narrationEnabled?: boolean;
  audioDurationSeconds?: number;
  downloadDelayMs?: number;
  sampleBytes?: Uint8Array;
  runtimeAssetPath?: string;
  hostLimits?: Awaited<
    ReturnType<NonNullable<AgentToolSandboxServices["ensureCurrentSession"]>>
  >["hostLimits"];
}) {
  const commands: string[] = [];
  const mp4 = options?.mp4 ?? fastStartMp4;
  const sceneRanges = new Map([
    [1, [0, 59] as const],
    [2, [60, 149] as const],
  ]);
  const executeCurrent: NonNullable<
    AgentToolSandboxServices["executeCurrent"]
  > = async (input) => {
    commands.push(input.command);
    options?.onCommand?.(input.command);
    if (input.signal?.aborted && options?.onAbortedCommand) {
      await options.onAbortedCommand(input.signal);
      throw input.signal.reason ?? new Error("command aborted");
    }
    if (
      options?.failCommandIncludes &&
      input.command.includes(options.failCommandIncludes)
    ) {
      return {
        exitCode: 1,
        output: options.failureOutput ?? "command failed",
      };
    }
    const scene = /render-scene -- (\d+)/u.exec(input.command);
    if (scene) {
      const slideNumber = Number(scene[1]);
      const range = sceneRanges.get(slideNumber)!;
      return {
        exitCode: 0,
        output: JSON.stringify({
          ok: true,
          stage: "render-scene",
          slideNumber,
          file: `out/scenes/scene-${slideNumber}.ts`,
          byteLength: 10 + slideNumber,
          contentDigest: `sha256:${String(slideNumber).repeat(64)}`,
          from: range[0],
          to: range[1],
          reused: false,
        }),
      };
    }
    if (input.command.includes("render-audio")) {
      const narrated = options?.narrationEnabled === true;
      return {
        exitCode: 0,
        output: JSON.stringify({
          ok: true,
          stage: "render-audio",
          file: narrated ? "out/audio.aac" : null,
          byteLength: narrated ? 12 : 0,
          contentDigest: narrated ? `sha256:${"a".repeat(64)}` : null,
        }),
      };
    }
    if (input.command.includes("concat-video")) {
      return {
        exitCode: 0,
        output: JSON.stringify({
          ok: true,
          stage: "render-video",
          file: "out/video.mp4",
          byteLength: mp4.byteLength,
          contentDigest: sha256Digest(mp4),
          durationInFrames: project.durationInFrames,
          fps: project.fps,
          width: project.width,
          height: project.height,
          hasAudio: options?.narrationEnabled === true,
        }),
      };
    }
    if (input.command.includes("ffprobe")) {
      return {
        exitCode: 0,
        output: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              width: project.width,
              height: project.height,
              avg_frame_rate: "30/1",
              duration: "5.000000",
              nb_read_frames: "150",
            },
            ...(options?.narrationEnabled
              ? [
                  {
                    codec_type: "audio",
                    duration: String(options.audioDurationSeconds ?? 5),
                  },
                ]
              : []),
          ],
          format: { duration: "5.000000" },
        }),
      };
    }
    return { exitCode: 0, output: "ok" };
  };
  const sandbox = {
    ensureCurrentSession: async () => ({
      sessionGeneration: "session",
      ...(options?.hostLimits ? { hostLimits: options.hostLimits } : {}),
      ...(options?.runtimeAssetPath
        ? {
            runtimeAssets: {
              "chrome-headless-shell": options.runtimeAssetPath,
            },
          }
        : {}),
    }),
    executeCurrent,
    downloadCurrentFile: async ({ sandboxPath }) => {
      if (options?.downloadDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.downloadDelayMs),
        );
      }
      return sandboxPath.endsWith("video.mp4")
        ? mp4
        : (options?.sampleBytes ?? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    },
  } as AgentToolSandboxServices;
  return { commands, sandbox };
}

test("host-resolved browser assets are exported into trusted render commands", async () => {
  const { commands, sandbox } = harness({
    runtimeAssetPath:
      "/workspace/.sourceweft-assets/chrome/current/chrome-headless-shell",
  });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/project",
    project,
    samples,
  });
  await session.dispose();
  assert.equal(
    commands[0],
    "export SOURCEWEFT_REMOTION_BROWSER='/workspace/.sourceweft-assets/chrome/current/chrome-headless-shell' && cd '/workspace/project' && pnpm run prepare-render",
  );
});

function renderPolicy(
  overrides: Partial<VideoPresentationRenderPolicy>,
): VideoPresentationRenderPolicy {
  return Object.freeze({ ...VIDEO_PRESENTATION_RENDER_POLICY, ...overrides });
}

test("render policy derives a bounded bitrate from duration and byte budget", () => {
  const short = deriveVideoRenderBitrate({
    durationInFrames: 150,
    fps: 30,
    narrationEnabled: true,
    policy: VIDEO_PRESENTATION_RENDER_POLICY,
  });
  const long = deriveVideoRenderBitrate({
    durationInFrames: 2_550,
    fps: 30,
    narrationEnabled: true,
    policy: VIDEO_PRESENTATION_RENDER_POLICY,
  });

  assert.ok(short.videoBitrateBps > long.videoBitrateBps);
  assert.match(long.remotionVideoBitrate, /^\d+k$/u);
  assert.ok(
    long.projectedBytes <= VIDEO_PRESENTATION_RENDER_POLICY.maxOutputBytes,
  );
  const tightened = resolveVideoPresentationRenderPolicy({
    commandTimeoutMs: 30_000,
    maxOutputChars: 1_000,
    maxUploadFileBytes: 1_000,
    maxUploadTotalBytes: 1_000,
    maxDownloadFileBytes: 2_000_000,
    maxDownloadTotalBytes: 1_500_000,
    maxCaptureFiles: 20,
  });
  assert.equal(tightened.commandTimeoutMs, 30_000);
  assert.equal(tightened.maxOutputBytes, 1_500_000);
  assert.equal(tightened.maxSampleBytes, 1_500_000);
});

test("one prepared bundle feeds samples, ordered scene chunks, mux, probe, and bytes", async () => {
  const { commands, sandbox } = harness();
  const port = createSandboxVideoPresentationRenderPort({ sandbox });
  const session = await port.prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
  });
  try {
    const renderedSamples = await session.renderSamples();
    const rendered = await session.renderFinal();

    assert.equal(renderedSamples.length, 2);
    assert.deepEqual(rendered.bytes, fastStartMp4);
    assert.equal(rendered.report.contentDigest, sha256Digest(fastStartMp4));
    assert.equal(rendered.report.durationInFrames, 150);
    assert.equal(rendered.report.hasAudio, false);
    assert.ok(rendered.timings.totalMs >= 0);
    assert.deepEqual(
      commands.flatMap((command) => {
        if (command.includes("prepare-render")) return ["prepare"];
        if (command.includes("render-validation-samples")) return ["samples"];
        const scene = /render-scene -- (\d+)/u.exec(command);
        if (scene) return [`scene:${scene[1]}`];
        if (command.includes("render-audio")) return ["audio"];
        if (command.includes("concat-video")) return ["concat"];
        if (command.includes("ffprobe")) return ["probe"];
        return [];
      }),
      ["prepare", "samples", "scene:1", "scene:2", "audio", "concat", "probe"],
    );
    assert.equal(
      commands.filter((command) => command.includes("prepare-render")).length,
      1,
    );
    assert.ok(
      commands.some(
        (command) =>
          command.includes("ffprobe") && command.includes("-count_frames"),
      ),
    );
  } finally {
    await session.dispose();
  }
});

test("final render requires samples and stops future scenes after cancellation", async () => {
  const controller = new AbortController();
  const { commands, sandbox } = harness({
    onCommand(command) {
      if (command.includes("render-scene -- 1")) controller.abort();
    },
  });
  const port = createSandboxVideoPresentationRenderPort({ sandbox });
  const session = await port.prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
    signal: controller.signal,
  });
  await session.renderSamples();
  await assert.rejects(session.renderFinal(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_CANCELLED");
    return true;
  });
  assert.equal(
    commands.some((command) => command.includes("render-scene -- 2")),
    false,
  );
  await session.dispose();
});

test("tool wall-clock timeout remains a timeout rather than user cancellation", async () => {
  const controller = new AbortController();
  const timeout = Object.assign(new Error("tool execution timed out"), {
    code: "AGENT_TOOL_EXECUTION_TIMEOUT",
    name: "TimeoutError",
  });
  const { sandbox } = harness({
    onCommand(command) {
      if (command.includes("render-scene -- 1")) controller.abort(timeout);
    },
  });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
    signal: controller.signal,
  });
  await session.renderSamples();
  await assert.rejects(session.renderFinal(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_TIMEOUT");
    return true;
  });
  await session.dispose();
});

test("render waits for trusted sandbox cancellation cleanup before returning", async () => {
  const controller = new AbortController();
  let cleanupStarted!: () => void;
  let releaseCleanup!: () => void;
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const { sandbox } = harness({
    onCommand(command) {
      if (command.includes("render-scene -- 1")) controller.abort();
    },
    async onAbortedCommand() {
      cleanupStarted();
      await release;
    },
  });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
    signal: controller.signal,
  });
  await session.renderSamples();
  let settled = false;
  const pending = session.renderFinal().finally(() => {
    settled = true;
  });
  await started;
  await Promise.resolve();
  assert.equal(settled, false);
  releaseCleanup();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_CANCELLED");
    return true;
  });
  await session.dispose();
});

test("download timeout waits for trusted download cleanup before returning", async () => {
  let cleanupStarted!: () => void;
  let releaseCleanup!: () => void;
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const base = harness();
  const sandbox: AgentToolSandboxServices = {
    ...base.sandbox,
    async downloadCurrentFile(input) {
      // A real download keeps its socket alive while the production deadline
      // is unref'ed. This finite handle gives the promise-only fake the same
      // lifetime, including the cleanup period after cancellation.
      const activeDownload = setTimeout(() => {}, 1_000);
      try {
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              cleanupStarted();
              resolve();
            },
            { once: true },
          );
        });
        await release;
        throw input.signal?.reason ?? new Error("download aborted");
      } finally {
        clearTimeout(activeDownload);
      }
    },
  };
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
    policy: renderPolicy({ overallTimeoutMs: 10 }),
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
  });
  let settled = false;
  const pending = session.renderSamples().finally(() => {
    settled = true;
  });
  await started;
  await Promise.resolve();
  assert.equal(settled, false);
  releaseCleanup();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_TIMEOUT");
    return true;
  });
  await session.dispose();
});

test("unconfirmed sandbox termination is never downgraded to cancelled", async () => {
  const controller = new AbortController();
  const { sandbox } = harness({
    onCommand(command) {
      if (command.includes("render-scene -- 1")) controller.abort();
    },
    async onAbortedCommand() {
      throw Object.assign(new Error("termination was not confirmed"), {
        code: "SANDBOX_TERMINATION_UNKNOWN",
      });
    },
  });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
    signal: controller.signal,
  });
  await session.renderSamples();
  await assert.rejects(session.renderFinal(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "SANDBOX_TERMINATION_UNKNOWN");
    return true;
  });
  await session.dispose();
});

test("host probe success cannot bless a non-faststart MP4", async () => {
  const nonFastStart = join(
    box("ftyp"),
    box("mdat", new Uint8Array([1])),
    box("moov"),
  );
  const { sandbox } = harness({ mp4: nonFastStart });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
  });
  await session.renderSamples();
  await assert.rejects(session.renderFinal(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_MP4_NOT_STREAMABLE");
    return true;
  });
  await session.dispose();
});

test("narrated projects require and confirm the audio stream", async () => {
  const { commands, sandbox } = harness({ narrationEnabled: true });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/video",
    project: { ...project, narrationEnabled: true },
    samples,
  });
  await session.renderSamples();
  const rendered = await session.renderFinal();

  assert.equal(rendered.report.hasAudio, true);
  assert.ok(
    commands.some(
      (command) =>
        command.includes("render-audio") &&
        command.includes("SOURCEWEFT_AUDIO_BITRATE=128k"),
    ),
  );
  await session.dispose();
});

test("narrated projects reject an audio stream that does not cover the timeline", async () => {
  const { sandbox } = harness({
    narrationEnabled: true,
    audioDurationSeconds: 0.1,
  });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/video",
    project: { ...project, narrationEnabled: true },
    samples,
  });
  await session.renderSamples();
  await assert.rejects(session.renderFinal(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_MEDIA_PROBE_MISMATCH");
    assert.equal(error.stage, "probe");
    return true;
  });
  await session.dispose();
});

test("idle visual-review time does not consume the active render budget", async () => {
  const { sandbox } = harness();
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
    policy: renderPolicy({ overallTimeoutMs: 25 }),
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
  });
  await session.renderSamples();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const rendered = await session.renderFinal();
  assert.deepEqual(rendered.bytes, fastStartMp4);
  assert.ok(rendered.timings.totalMs < 25);
  await session.dispose();
});

test("an active download cannot exceed the remaining render budget", async () => {
  const { sandbox } = harness({ downloadDelayMs: 40 });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
    policy: renderPolicy({ overallTimeoutMs: 10 }),
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
  });
  await assert.rejects(session.renderSamples(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_TIMEOUT");
    assert.equal(error.stage, "download");
    return true;
  });
  await session.dispose();
});

test("validation samples enforce their cumulative byte ceiling", async () => {
  const { sandbox } = harness({ sampleBytes: new Uint8Array(4) });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
    policy: renderPolicy({ maxSampleBytes: 7 }),
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
  });
  await assert.rejects(session.renderSamples(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_SAMPLE_BYTES_EXCEEDED");
    assert.deepEqual(error.details, { byteLength: 8, maxBytes: 7 });
    return true;
  });
  await session.dispose();
});

test("scene, audio, and mux failures stop every dependent phase", async (t) => {
  const cases = [
    {
      failed: "render-scene -- 2",
      forbidden: "render-audio",
      stage: "scene",
    },
    { failed: "render-audio", forbidden: "concat-video", stage: "audio" },
    { failed: "concat-video", forbidden: "ffprobe", stage: "mux" },
  ] as const;
  for (const fixture of cases) {
    await t.test(fixture.stage, async () => {
      const { commands, sandbox } = harness({
        failCommandIncludes: fixture.failed,
      });
      const session = await createSandboxVideoPresentationRenderPort({
        sandbox,
      }).prepare({
        canonicalRoot: "/workspace/video",
        project,
        samples,
      });
      await session.renderSamples();
      await assert.rejects(session.renderFinal(), (error: unknown) => {
        assert.ok(error instanceof VideoPresentationRenderError);
        assert.equal(error.code, "VIDEO_RENDER_COMMAND_FAILED");
        assert.equal(error.stage, fixture.stage);
        return true;
      });
      assert.equal(
        commands.some((command) => command.includes(fixture.forbidden)),
        false,
      );
      await session.dispose();
    });
  }
});

test("sandbox timeout remains a timeout diagnostic", async () => {
  const { sandbox } = harness({
    failCommandIncludes: "render-scene -- 1",
    failureOutput:
      "SANDBOX_COMMAND_TIMEOUT: command exceeded the configured timeout",
  });
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
  });
  await session.renderSamples();
  await assert.rejects(session.renderFinal(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_TIMEOUT");
    return true;
  });
  await session.dispose();
});

test("trusted-host timeout errors remain video timeout diagnostics", async () => {
  const base = harness();
  const executeCurrent = base.sandbox.executeCurrent!;
  const sandbox: AgentToolSandboxServices = {
    ...base.sandbox,
    async executeCurrent(input) {
      if (input.command.includes("render-scene -- 1")) {
        throw Object.assign(
          new Error("Sandbox sandbox termination was confirmed after timeout."),
          { code: "SANDBOX_HOST_OPERATION_TIMED_OUT" },
        );
      }
      return executeCurrent(input);
    },
  };
  const session = await createSandboxVideoPresentationRenderPort({
    sandbox,
  }).prepare({
    canonicalRoot: "/workspace/video",
    project,
    samples,
  });
  await session.renderSamples();
  await assert.rejects(session.renderFinal(), (error: unknown) => {
    assert.ok(error instanceof VideoPresentationRenderError);
    assert.equal(error.code, "VIDEO_RENDER_TIMEOUT");
    return true;
  });
  await session.dispose();
});
