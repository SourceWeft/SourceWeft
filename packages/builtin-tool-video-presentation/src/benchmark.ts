import type { AgentToolSandboxServices } from "@sourceweft/contracts/agent-tools";
import { videoPresentationRenderableProjectSchema } from "@sourceweft/contracts/video-presentation";
import { createSandboxVideoPresentationRenderPort } from "./agent/render-port";
import { materializeVideoPresentationAssetUris } from "./pipeline/asset-uris";
import { buildValidationProjectCodePayload } from "./pipeline/project-code";

type BenchmarkCommandResult = {
  exitCode: number | null;
  output: string;
  truncated?: boolean;
};

type BenchmarkSandboxProvider = {
  createSandbox(input: {
    labels: Record<string, string>;
    ttlSeconds: number;
  }): Promise<{ id: string }>;
  deleteSandbox(id: string): Promise<unknown>;
  ensureDirectory(input: {
    providerSandboxId: string;
    directory: string;
  }): Promise<unknown>;
  uploadFile(input: {
    providerSandboxId: string;
    sandboxPath: string;
    content: Uint8Array;
  }): Promise<unknown>;
  downloadFile(input: {
    providerSandboxId: string;
    sandboxPath: string;
  }): Promise<Buffer | Uint8Array>;
  execute(input: {
    providerSandboxId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
  }): Promise<BenchmarkCommandResult>;
  executeSystem?: BenchmarkSandboxProvider["execute"];
};

export type VideoRenderBenchmarkInput = {
  providerId: string;
  provider: BenchmarkSandboxProvider;
  limits: {
    ttlSeconds: number;
    batchCommandTimeoutMs: number;
    maxCommandTimeoutMs: number;
    maxOutputChars: number;
    maxPrepareFileBytes: number;
    maxPrepareTotalBytes: number;
    maxCollectFileBytes: number;
    maxCollectTotalBytes: number;
  };
};

const root = "/workspace/sourceweft-video-render-benchmark";
const sceneFrames = [330, 330, 330, 330, 330, 330, 285, 285] as const;
const fps = 30;
const benchmarkAssetId = "benchmark-hero";
export const VIDEO_RENDER_BENCHMARK_PHASES = [
  "cold",
  "warm",
  "warm",
  "warm",
] as const;
export const VIDEO_RENDER_WARM_TARGET_MS = 120_000;

export function buildVideoRenderBenchmarkFixture() {
  const slides = sceneFrames.map((durationInFrames, index) => ({
    slideNumber: index + 1,
    durationInFrames,
    audioDurationSeconds: durationInFrames / fps - 0.75,
  }));
  const durationSeconds =
    sceneFrames.reduce((sum, frames) => sum + frames, 0) / fps;
  const payload = videoPresentationRenderableProjectSchema.parse({
    narrationPolicy: { enabled: true },
    project: {
      title: "Trusted Sandbox Benchmark",
      fps,
      width: 1920,
      height: 1080,
      durationSeconds,
      stylePreset: "technical",
      globalVisualDirection:
        "Dark high-contrast technical layouts with restrained motion",
    },
    slides: slides.map(({ slideNumber }) => ({
      slideNumber,
      title: `Benchmark scene ${slideNumber}`,
      speakerTranscript: [`Narration for benchmark scene ${slideNumber}.`],
      sceneIntent: `Render deterministic benchmark scene ${slideNumber}`,
      assetRefs:
        slideNumber === 1 ? [{ assetId: benchmarkAssetId, role: "hero" }] : [],
      assetNeeds: [],
    })),
    sceneModules: slides.map(({ slideNumber, durationInFrames }) => ({
      slideNumber,
      title: `Benchmark scene ${slideNumber}`,
      componentName: "VideoScene",
      durationInFrames,
      diagnostics: [],
      layoutWarnings: [],
      compileStatus: "compiled",
      code: `export default function VideoScene(){ const frame = useCurrentFrame(); const progress = interpolate(frame, [0, ${durationInFrames - 1}], [0, 100], {extrapolateRight: "clamp"}); return <AbsoluteFill style={{backgroundColor: "#070b18", color: "white"}}>${slideNumber === 1 ? `<AssetImage src="sourceweft-asset:${benchmarkAssetId}" style={{position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.25}} />` : ""}<SafeArea gap={36}><TitleBlock title="Benchmark scene ${slideNumber}" subtitle="Trusted sandbox rendering" /><div style={{height: 18, width: "100%", backgroundColor: "#1f2937", borderRadius: 9}}><div style={{height: "100%", width: progress + "%", backgroundColor: "#38bdf8", borderRadius: 9}} /></div></SafeArea></AbsoluteFill>; }`,
    })),
    audioTracks: slides.map(({ slideNumber, audioDurationSeconds }) => ({
      slideNumber,
      durationSeconds: audioDurationSeconds,
      mimeType: "audio/mpeg",
      fileName: `slide-${slideNumber}.mp3`,
      assetUrl: `/audio/slide-${slideNumber}.mp3`,
      storageKey: `benchmark/audio/slide-${slideNumber}.mp3`,
      storageBucket: "benchmark",
      contentDigest: `sha256:${"0".repeat(64)}`,
      contentType: "audio/mpeg",
    })),
    assets: [
      {
        assetId: benchmarkAssetId,
        type: "hero",
        prompt: "A deterministic 1080p technical grid benchmark image",
        fileName: "benchmark-hero.png",
        storageKey: "benchmark/assets/benchmark-hero.png",
        storageBucket: "benchmark",
        sourceUrl: "/public/assets/benchmark-hero.png",
        contentDigest: `sha256:${"0".repeat(64)}`,
        contentType: "image/png",
        slideNumbers: [1],
        source: "provided",
      },
    ],
    preview: { slideCount: slides.length, durationSeconds },
    renderProfile: {
      stylePreset: "technical",
      visualDensity: "balanced",
      durationTarget: "medium",
      language: "en",
    },
    themeAssignments: [],
    sourceDigest: "Deterministic trusted sandbox benchmark fixture",
  });
  const narrationFiles = slides.map(
    ({ slideNumber, audioDurationSeconds }) => ({
      slideNumber,
      fileName: `slide-${slideNumber}.mp3`,
      durationSeconds: audioDurationSeconds,
    }),
  );
  return {
    payload,
    project: buildValidationProjectCodePayload(
      materializeVideoPresentationAssetUris(payload),
      { narrationFiles },
    ),
    narrationFiles,
  };
}

function assertSuccess(stage: string, result: BenchmarkCommandResult) {
  if (result.exitCode !== 0 || result.truncated) {
    throw new Error(
      `${stage} failed (${result.exitCode}): ${result.output.slice(-4_000)}`,
    );
  }
}

export const sandboxCapabilityBenchmark = {
  id: "video-presentation-render",
  async run(input: VideoRenderBenchmarkInput) {
    const { provider, limits } = input;
    const created = await provider.createSandbox({
      labels: { purpose: "video-render-benchmark" },
      ttlSeconds: limits.ttlSeconds,
    });
    const providerSandboxId = created.id;
    const execute = async (command: string, timeoutMs: number) =>
      (provider.executeSystem ?? provider.execute).call(provider, {
        providerSandboxId,
        command,
        cwd: "/workspace",
        timeoutMs,
        maxOutputChars: limits.maxOutputChars,
      });

    try {
      const { payload, project, narrationFiles } =
        buildVideoRenderBenchmarkFixture();
      for (const file of project.files) {
        const path = `${root}/${file.path}`;
        await provider.ensureDirectory({
          providerSandboxId,
          directory: path.slice(0, path.lastIndexOf("/")),
        });
        await provider.uploadFile({
          providerSandboxId,
          sandboxPath: path,
          content: new TextEncoder().encode(file.content),
        });
      }
      const audioCommand = narrationFiles
        .map(
          (file) =>
            `ffmpeg -y -v error -f lavfi -i anullsrc=r=44100:cl=stereo -t ${file.durationSeconds.toFixed(3)} -c:a libmp3lame ${root}/public/audio/${file.fileName}`,
        )
        .join(" && ");
      assertSuccess(
        "media fixture",
        await execute(
          `mkdir -p ${root}/public/audio ${root}/public/assets && ${audioCommand} && ffmpeg -y -v error -f lavfi -i "color=c=0x0b1020:s=1920x1080" -vf "drawgrid=width=120:height=120:thickness=2:color=0x38bdf8@0.35" -frames:v 1 ${root}/public/assets/benchmark-hero.png`,
          limits.batchCommandTimeoutMs,
        ),
      );
      const installStartedAt = Date.now();
      assertSuccess(
        "install",
        await execute(
          `cd ${root} && pnpm install --frozen-lockfile --ignore-scripts --prefer-offline --store-dir "\${SOURCEWEFT_PNPM_STORE:-.pnpm-store}" && pnpm run build && pnpm run render-smoke`,
          limits.batchCommandTimeoutMs,
        ),
      );
      const installMs = Date.now() - installStartedAt;
      const hostLimits = {
        commandTimeoutMs: Math.min(
          limits.batchCommandTimeoutMs,
          limits.maxCommandTimeoutMs,
        ),
        maxOutputChars: limits.maxOutputChars,
        maxUploadFileBytes: limits.maxPrepareFileBytes,
        maxUploadTotalBytes: limits.maxPrepareTotalBytes,
        maxDownloadFileBytes: limits.maxCollectFileBytes,
        maxDownloadTotalBytes: limits.maxCollectTotalBytes,
        maxCaptureFiles: 200,
      };
      const sandbox: AgentToolSandboxServices = {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({
          sessionGeneration: providerSandboxId,
          hostLimits,
        }),
        executeCurrent: async (commandInput) =>
          execute(
            commandInput.command,
            Math.min(
              commandInput.timeoutMs ?? hostLimits.commandTimeoutMs,
              hostLimits.commandTimeoutMs,
            ),
          ),
        downloadCurrentFile: async ({ sandboxPath }) =>
          provider.downloadFile({ providerSandboxId, sandboxPath }),
      };
      const port = createSandboxVideoPresentationRenderPort({ sandbox });
      const runs: Array<Record<string, unknown>> = [];
      for (const [run, phase] of VIDEO_RENDER_BENCHMARK_PHASES.entries()) {
        const session = await port.prepare({
          canonicalRoot: root,
          project: {
            durationInFrames: sceneFrames.reduce(
              (sum, frames) => sum + frames,
              0,
            ),
            fps,
            width: payload.project.width,
            height: payload.project.height,
            narrationEnabled: true,
            scenes: sceneFrames.map((durationInFrames, index) => ({
              slideNumber: index + 1,
              durationInFrames,
            })),
          },
          samples: project.validationSamples,
        });
        try {
          const samples = await session.renderSamples();
          const output = await session.renderFinal();
          runs.push({
            run: run + 1,
            phase,
            sampleCount: samples.length,
            byteLength: output.bytes.byteLength,
            ...output.timings,
          });
        } finally {
          await session.dispose();
        }
      }
      const warmRuns = runs.filter((run) => run.phase === "warm");
      const passed = warmRuns.every(
        (run) =>
          typeof run.totalMs === "number" &&
          run.totalMs <= VIDEO_RENDER_WARM_TARGET_MS,
      );
      return {
        benchmarkId: "video-presentation-render",
        provider: input.providerId,
        sandboxId: providerSandboxId,
        installMs,
        warmTargetMs: VIDEO_RENDER_WARM_TARGET_MS,
        passed,
        runs,
      };
    } finally {
      await provider.deleteSandbox(providerSandboxId).catch(() => undefined);
    }
  },
};
