import { VIDEO_LAYOUT_PRIMITIVES_TSX } from "./layout-source";
import type { VideoPresentationRenderableProject } from "@sourceweft/contracts/video-presentation";
import { VIDEO_SCENE_COMPONENT_NAME } from "./config";
import {
  REMOTION_BROWSER_ENV_VAR,
  REMOTION_RENDERER_VERSION,
} from "./renderer-version";
import { normalizeSceneProjectCode } from "./scene-source";
import { VIDEO_PRESENTATION_PNPM_LOCK } from "./project-pnpm-lock";

/**
 * Browser resolution prelude shared by every render script.
 *
 * The trusted sandbox image provides Chrome Headless Shell as an absolute path
 * in `SOURCEWEFT_REMOTION_BROWSER`. Rendering fails fast when that pinned
 * dependency is absent; it never downloads a different browser at runtime.
 */
const PROJECT_BROWSER_PRELUDE_LINES = [
  `const browserExecutable = process.env.${REMOTION_BROWSER_ENV_VAR} || null;`,
  'if (!browserExecutable) throw new Error("SOURCEWEFT_REMOTION_BROWSER is required by the trusted render policy");',
  "const browserOptions = { browserExecutable };",
  "async function ensureTrustedBrowser() {",
  "  await ensureBrowser({ browserExecutable });",
  "}",
];

/**
 * Narration file the sandbox has (or will have) staged under the generated
 * project's `public/` directory. Supplying these is what makes the mp4 render
 * carry sound: the composition can only reach audio through `staticFile`,
 * because the sandbox has no network access to the artifact asset route.
 */
export type ProjectNarrationFile = {
  slideNumber: number;
  /** Base name inside `public/audio/`, e.g. `slide-3.mp3`. */
  fileName: string;
  /**
   * The staged file's own measured length, taken at staging time from these
   * exact bytes (`stageNarrationForRender`). The manifest publishes THIS, not
   * `payload.audioTracks[].durationSeconds`, so the smoke check compares two
   * independently obtained numbers — see the manifest's `audioDurationSeconds`.
   */
  durationSeconds: number;
};

/** Directory (relative to the project root) narration is staged into. */
export const PROJECT_NARRATION_DIR = "public/audio";

/** Where `concat-video` writes the finished mp4, relative to the project root. */
export const PROJECT_RENDERED_VIDEO_PATH = "out/video.mp4";

/**
 * Per-scene video chunks, one file per slide, written by `render-scene`.
 *
 * They are MPEG-TS rather than mp4 because that is the one container ffmpeg can
 * join with the `concat:` protocol without re-encoding — which is exactly what
 * `combineChunks` does for an h264 output (`canConcatVideoSeamlessly` is true
 * only for h264). Chunks are therefore never a deliverable on their own; they
 * are only ever the input to `concat-video`.
 */
export const PROJECT_SCENE_CHUNK_DIR = "out/scenes";

/**
 * Whole-deck narration mix, written by `render-audio`. Audio is rendered in one
 * pass rather than per scene on purpose: `combineChunks` reassembles audio
 * assuming every chunk is the *same* length (`i * chunkDurationInSeconds`), and
 * our scenes are not equal-length, so per-scene audio chunks would be stitched
 * at the wrong offsets. One audio file spanning the whole composition is the
 * degenerate — and correct — case of that assumption.
 */
export const PROJECT_NARRATION_AUDIO_PATH = "out/audio.aac";

/**
 * Bundle output directory. Every per-scene command has to bundle before it can
 * render, so the bundle is aimed at a stable path instead of a fresh temp dir
 * per command; when the bundler's on-disk cache hits, later scenes skip most of
 * that work. A miss costs only the bundle time the command would have paid anyway.
 */
export const PROJECT_BUNDLE_DIR = "out/bundle";

export function buildProjectCodePayload(
  payload: VideoPresentationRenderableProject,
  options?: {
    /**
     * Omit for the default (silent) project — the output is then byte-identical
     * to what the pipeline persists, which is why the mp4 path can add audio
     * without changing the payload every other stage writes.
     */
    narrationFiles?: ReadonlyArray<ProjectNarrationFile>;
  },
) {
  const narrationBySlide = new Map(
    (options?.narrationFiles ?? []).map((file) => [file.slideNumber, file]),
  );
  const sceneModules =
    payload.sceneModules.length > 0
      ? payload.sceneModules
      : [
          {
            slideNumber: 1,
            title: payload.project.title,
            code: [
              'import React from "react";',
              'import { AbsoluteFill } from "remotion";',
              "export default function VideoScene() {",
              `  return <AbsoluteFill style={{ background: "#101820", color: "white", padding: 96 }}>${JSON.stringify(payload.project.title)}</AbsoluteFill>;`,
              "}",
            ].join("\n"),
            componentName: VIDEO_SCENE_COMPONENT_NAME,
            durationInFrames: Math.max(1, Math.round(payload.project.fps * 5)),
            repairAttempts: 0,
            diagnostics: [],
            compileStatus: "compiled" as const,
          },
        ];
  const sceneFiles = sceneModules.map((scene) => ({
    path: `src/scenes/Slide${scene.slideNumber}.tsx`,
    content: [
      "// @ts-nocheck",
      `// Slide ${scene.slideNumber}: ${scene.title}`,
      normalizeSceneProjectCode(scene.code),
    ].join("\n"),
  }));
  const sceneImports = sceneModules
    .map(
      (scene) =>
        `import Slide${scene.slideNumber} from "./scenes/Slide${scene.slideNumber}";`,
    )
    .join("\n");
  const sceneEntries = sceneModules.map((scene) => ({
    slideNumber: scene.slideNumber,
    title: scene.title,
    durationInFrames: scene.durationInFrames,
    componentName: `Slide${scene.slideNumber}`,
    narrationFile: narrationBySlide.get(scene.slideNumber)?.fileName ?? null,
  }));
  const hasNarration = sceneEntries.some((scene) => scene.narrationFile);
  const totalDurationInFrames = sceneModules.reduce(
    (sum, scene) => sum + scene.durationInFrames,
    0,
  );
  return {
    entryFile: "src/index.ts",
    files: [
      {
        path: "src/scenes/layout-primitives.tsx",
        content: VIDEO_LAYOUT_PRIMITIVES_TSX,
      },
      ...sceneFiles,
      {
        path: "src/VideoScene.tsx",
        content: [
          'import React from "react";',
          // `Audio`/`staticFile` are only imported when narration is staged, so
          // the silent project keeps exactly the imports it always had.
          hasNarration
            ? 'import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";'
            : 'import { AbsoluteFill, Sequence } from "remotion";',
          sceneImports,
          "",
          "const sceneEntries = [",
          ...sceneEntries.map(
            (scene) =>
              `  { slideNumber: ${scene.slideNumber}, title: ${JSON.stringify(scene.title)}, durationInFrames: ${scene.durationInFrames}, Component: ${scene.componentName}${hasNarration ? `, narrationFile: ${JSON.stringify(scene.narrationFile)}` : ""} },`,
          ),
          "] as const;",
          "",
          "export function getVideoDurationInFrames() {",
          `  return ${totalDurationInFrames};`,
          "}",
          "",
          "export default function VideoScene() {",
          "  let frameCursor = 0;",
          "  return (",
          '    <AbsoluteFill style={{ background: "#05070d" }}>',
          "      {sceneEntries.map((scene) => {",
          "        const from = frameCursor;",
          "        frameCursor += scene.durationInFrames;",
          "        const SceneComponent = scene.Component;",
          "        return (",
          "          <Sequence",
          "            durationInFrames={scene.durationInFrames}",
          "            from={from}",
          "            key={scene.slideNumber}",
          "          >",
          "            <SceneComponent />",
          // Narration rides inside the scene's Sequence so it starts with the
          // slide and is cut off at the slide boundary, exactly like the
          // browser player composes it.
          ...(hasNarration
            ? [
                '            {scene.narrationFile ? <Audio src={staticFile("audio/" + scene.narrationFile)} /> : null}',
              ]
            : []),
          "          </Sequence>",
          "        );",
          "      })}",
          "    </AbsoluteFill>",
          "  );",
          "}",
        ].join("\n"),
      },
      {
        path: "src/Root.tsx",
        content: [
          'import React from "react";',
          'import { Composition } from "remotion";',
          'import VideoScene, { getVideoDurationInFrames } from "./VideoScene";',
          "",
          "export default function RemotionRoot() {",
          "  return (",
          "    <Composition",
          '      id="video-presentation"',
          "      component={VideoScene}",
          "      durationInFrames={getVideoDurationInFrames()}",
          `      fps={${payload.project.fps}}`,
          `      width={${payload.project.width}}`,
          `      height={${payload.project.height}}`,
          "    />",
          "  );",
          "}",
        ].join("\n"),
      },
      {
        path: "src/security.ts",
        content: [
          "const policy = \"default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\";",
          'const meta = document.createElement("meta");',
          'meta.httpEquiv = "Content-Security-Policy";',
          "meta.content = policy;",
          "document.head.prepend(meta);",
        ].join("\n"),
      },
      {
        path: "src/index.ts",
        content: [
          'import "./security";',
          'import { registerRoot } from "remotion";',
          'import RemotionRoot from "./Root";',
          "",
          "registerRoot(RemotionRoot);",
        ].join("\n"),
      },
      {
        path: "package.json",
        content: JSON.stringify(
          {
            private: true,
            packageManager: "pnpm@10.19.0",
            scripts: {
              build: "tsc -p tsconfig.json --noEmit",
              "render-smoke": "node scripts/render-smoke.mjs",
            },
            dependencies: {
              remotion: REMOTION_RENDERER_VERSION,
              react: "18.3.1",
              "react-dom": "18.3.1",
            },
            devDependencies: {
              "@types/react": "18.3.18",
              "@types/react-dom": "18.3.5",
              typescript: "5.9.2",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "tsconfig.json",
        content: JSON.stringify(
          {
            compilerOptions: {
              allowSyntheticDefaultImports: true,
              esModuleInterop: true,
              isolatedModules: true,
              jsx: "react-jsx",
              lib: ["DOM", "DOM.Iterable", "ES2022"],
              module: "ESNext",
              moduleResolution: "Bundler",
              noEmit: true,
              skipLibCheck: true,
              strict: true,
              target: "ES2022",
            },
            include: ["src/**/*.ts", "src/**/*.tsx"],
          },
          null,
          2,
        ),
      },
      {
        path: "video-presentation.manifest.json",
        content: JSON.stringify(
          {
            durationInFrames: totalDurationInFrames,
            fps: payload.project.fps,
            height: payload.project.height,
            scenes: sceneModules.map((scene) => ({
              // The length `render-smoke` holds the scene to. On an mp4 render
              // this is the file staged under `public/audio/`, measured at
              // staging time from those exact bytes — deliberately NOT
              // `payload.audioTracks[].durationSeconds`, which is where
              // `scene.durationInFrames` already came from
              // (`ceil((durationSeconds + tail padding) * fps)` in
              // `scene-gen.ts`). Two numbers from one measurement can only ever
              // agree; these two are obtained independently, at different times,
              // so a scene that no longer covers the audio it will be mixed with
              // fails the check instead of shipping clipped.
              //
              // A silent build (no `narrationFiles`) has nothing staged to
              // measure, so it falls back to the payload's measurement. That
              // build is the one the pipeline persists as `projectCode`; it is
              // never the one an mp4 is rendered from.
              audioDurationSeconds:
                narrationBySlide.get(scene.slideNumber)?.durationSeconds ??
                payload.audioTracks.find(
                  (track) => track.slideNumber === scene.slideNumber,
                )?.durationSeconds ??
                null,
              durationInFrames: scene.durationInFrames,
              file: `src/scenes/Slide${scene.slideNumber}.tsx`,
              // Only present on an mp4 render: the smoke check and the stills
              // renderer never look at it, and its absence keeps the manifest
              // identical to the silent build.
              ...(hasNarration
                ? {
                    narrationFile:
                      narrationBySlide.get(scene.slideNumber)?.fileName ?? null,
                  }
                : {}),
              slideNumber: scene.slideNumber,
              title: scene.title,
            })),
            slideCount: sceneModules.length,
            title: payload.project.title,
            width: payload.project.width,
          },
          null,
          2,
        ),
      },
      {
        // The one check that runs before any frame is rendered, and the only
        // place a timeline/narration mismatch is caught. It is a real check
        // now: `audioDurationSeconds` is measured from the staged audio file,
        // while `durationInFrames` was derived from the measurement taken back
        // at TTS time (see the manifest above). Failing it fails the run —
        // correctly, because a scene shorter than its narration clips that
        // slide's speech in the rendered MP4, so validation must reject it.
        path: "scripts/render-smoke.mjs",
        content: [
          'import { existsSync, readFileSync, statSync } from "node:fs";',
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          "if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {",
          '  throw new Error("manifest has no scenes");',
          "}",
          "for (const scene of manifest.scenes) {",
          "  if (!existsSync(new URL(`../${scene.file}`, import.meta.url))) {",
          "    throw new Error(`missing scene file: ${scene.file}`);",
          "  }",
          "  if (!Number.isInteger(scene.durationInFrames) || scene.durationInFrames <= 0) {",
          "    throw new Error(`invalid duration for slide ${scene.slideNumber}`);",
          "  }",
          "  if (scene.narrationFile) {",
          "    // A narrated scene must have the file it names, non-empty, and a",
          "    // known narration length. An unmeasured narrated scene would slip",
          "    // past the length check below by having nothing to compare.",
          `    const audioFile = new URL(\`../${PROJECT_NARRATION_DIR}/\${scene.narrationFile}\`, import.meta.url);`,
          "    if (!existsSync(audioFile) || statSync(audioFile).size === 0) {",
          "      throw new Error(`slide ${scene.slideNumber}: missing staged narration ${scene.narrationFile}`);",
          "    }",
          '    if (typeof scene.audioDurationSeconds !== "number" || !(scene.audioDurationSeconds > 0)) {',
          "      throw new Error(`slide ${scene.slideNumber}: narration ${scene.narrationFile} has no measured duration`);",
          "    }",
          "  }",
          '  if (typeof scene.audioDurationSeconds === "number" && scene.durationInFrames < Math.ceil(scene.audioDurationSeconds * manifest.fps)) {',
          "    throw new Error(`slide ${scene.slideNumber}: narration (${scene.audioDurationSeconds}s) exceeds scene duration (${scene.durationInFrames} frames @ ${manifest.fps}fps)`);",
          "  }",
          "}",
          'console.log(JSON.stringify({ ok: true, stage: "render-smoke", slideCount: manifest.scenes.length, durationInFrames: manifest.durationInFrames }));',
        ].join("\n"),
      },
    ],
  };
}

export type VideoValidationSampleDescriptor = {
  slideNumber: number;
  sampleId: "begin" | "middle" | "end";
  frame: number;
  relativePath: string;
};

/** Trusted validation builder with required begin/middle/end runtime samples. */
export function buildValidationProjectCodePayload(
  payload: VideoPresentationRenderableProject,
  options?: { narrationFiles?: ReadonlyArray<ProjectNarrationFile> },
) {
  const base = buildProjectCodePayload(payload, options);
  let frameCursor = 0;
  const validationSamples: VideoValidationSampleDescriptor[] = [];
  for (const scene of payload.sceneModules) {
    const positions = [
      ["begin", 0],
      ["middle", Math.floor(scene.durationInFrames / 2)],
      ["end", Math.max(0, scene.durationInFrames - 1)],
    ] as const;
    for (const [sampleId, localFrame] of positions) {
      validationSamples.push({
        slideNumber: scene.slideNumber,
        sampleId,
        frame: frameCursor + localFrame,
        relativePath: `out/slide-${scene.slideNumber}-${sampleId}.jpeg`,
      });
    }
    frameCursor += scene.durationInFrames;
  }
  const packageFile = base.files.find((file) => file.path === "package.json");
  if (!packageFile) {
    throw new Error("VIDEO_VALIDATION_BUILDER_PACKAGE_MISSING");
  }
  const packageJson = JSON.parse(packageFile.content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const validationScripts = { ...(packageJson.scripts ?? {}) };
  const files = base.files
    .filter((file) => file.path !== "package.json")
    .concat([
      {
        path: "package.json",
        content: JSON.stringify(
          {
            ...packageJson,
            dependencies: {
              ...(packageJson.dependencies ?? {}),
              "@remotion/bundler": REMOTION_RENDERER_VERSION,
              "@remotion/renderer": REMOTION_RENDERER_VERSION,
              remotion: REMOTION_RENDERER_VERSION,
              react: "18.3.1",
              "react-dom": "18.3.1",
            },
            devDependencies: {
              ...(packageJson.devDependencies ?? {}),
              "@types/react": "18.3.18",
              "@types/react-dom": "18.3.5",
              typescript: "5.9.2",
            },
            scripts: {
              ...validationScripts,
              "prepare-render": "node scripts/prepare-render.mjs",
              "render-validation-samples":
                "node scripts/render-validation-samples.mjs",
              "render-scene": "node scripts/render-scene.mjs",
              "render-audio": "node scripts/render-audio.mjs",
              "concat-video": "node scripts/concat-video.mjs",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "pnpm-lock.yaml",
        content: VIDEO_PRESENTATION_PNPM_LOCK,
      },
      {
        path: "scripts/prepare-render.mjs",
        content: [
          'import { mkdirSync, readFileSync, rmSync } from "node:fs";',
          'import { bundle } from "@remotion/bundler";',
          'import { ensureBrowser, selectComposition } from "@remotion/renderer";',
          "",
          ...PROJECT_BROWSER_PRELUDE_LINES,
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          'const outputDir = new URL("../out", import.meta.url).pathname;',
          'const publicDir = new URL("../public", import.meta.url).pathname;',
          `const bundleDir = new URL("../${PROJECT_BUNDLE_DIR}", import.meta.url).pathname;`,
          "rmSync(outputDir, { recursive: true, force: true });",
          "mkdirSync(outputDir, { recursive: true });",
          "mkdirSync(publicDir, { recursive: true });",
          "await ensureTrustedBrowser();",
          'const serveUrl = await bundle({ entryPoint: new URL("../src/index.ts", import.meta.url).pathname, publicDir, outDir: bundleDir });',
          'const composition = await selectComposition({ serveUrl, id: "video-presentation", ...browserOptions });',
          "if (composition.durationInFrames !== manifest.durationInFrames || composition.fps !== manifest.fps || composition.width !== manifest.width || composition.height !== manifest.height) {",
          '  throw new Error("prepared composition metadata does not match manifest");',
          "}",
          'console.log(JSON.stringify({ ok: true, stage: "prepare-render", bundle: "out/bundle", durationInFrames: composition.durationInFrames, fps: composition.fps, width: composition.width, height: composition.height }));',
        ].join("\n"),
      },
      {
        path: "scripts/render-validation-samples.mjs",
        content: [
          'import { mkdirSync } from "node:fs";',
          'import { ensureBrowser, renderStill, selectComposition } from "@remotion/renderer";',
          "",
          ...PROJECT_BROWSER_PRELUDE_LINES,
          "",
          `const samples = ${JSON.stringify(validationSamples)};`,
          `const serveUrl = new URL("../${PROJECT_BUNDLE_DIR}", import.meta.url).pathname;`,
          "await ensureTrustedBrowser();",
          'const composition = await selectComposition({ serveUrl, id: "video-presentation", ...browserOptions });',
          'mkdirSync(new URL("../out", import.meta.url), { recursive: true });',
          "for (const sample of samples) {",
          "  const frame = Math.min(composition.durationInFrames - 1, sample.frame);",
          "  const output = new URL(`../${sample.relativePath}`, import.meta.url).pathname;",
          '  await renderStill({ composition, serveUrl, frame, output, imageFormat: "jpeg", jpegQuality: 80, ...browserOptions });',
          "}",
          'console.log(JSON.stringify({ ok: true, stage: "render-validation-samples", rendered: samples }));',
        ].join("\n"),
      },
      {
        path: "scripts/render-scene.mjs",
        content: [
          'import { createHash } from "node:crypto";',
          'import { mkdirSync, readFileSync, statSync } from "node:fs";',
          'import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";',
          "",
          ...PROJECT_BROWSER_PRELUDE_LINES,
          "",
          'const positional = process.argv.slice(2).filter((arg) => arg !== "--");',
          "const slideNumber = Number(positional[0]);",
          "if (!Number.isInteger(slideNumber)) throw new Error(`render-scene expects a slide number, got ${JSON.stringify(positional[0])}`);",
          "const videoBitrate = process.env.SOURCEWEFT_VIDEO_BITRATE;",
          "const concurrency = Number(process.env.SOURCEWEFT_VIDEO_CONCURRENCY);",
          'if (!videoBitrate || !/^\\d+k$/u.test(videoBitrate) || !Number.isInteger(concurrency) || concurrency <= 0) throw new Error("trusted render policy environment is invalid");',
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          "let from = 0;",
          "let scene = null;",
          "for (const entry of manifest.scenes) {",
          "  if (entry.slideNumber === slideNumber) { scene = entry; break; }",
          "  from += entry.durationInFrames;",
          "}",
          "if (!scene) throw new Error(`no scene for slide ${slideNumber}`);",
          "const to = from + scene.durationInFrames - 1;",
          `const chunkDir = new URL("../${PROJECT_SCENE_CHUNK_DIR}/", import.meta.url).pathname;`,
          "mkdirSync(chunkDir, { recursive: true });",
          "const chunkFile = `${chunkDir}scene-${slideNumber}.ts`;",
          `const serveUrl = new URL("../${PROJECT_BUNDLE_DIR}", import.meta.url).pathname;`,
          "await ensureTrustedBrowser();",
          'const composition = await selectComposition({ serveUrl, id: "video-presentation", ...browserOptions });',
          'await renderMedia({ codec: "h264-ts", composition, concurrency, frameRange: [from, to], muted: true, outputLocation: chunkFile, serveUrl, videoBitrate, ...browserOptions });',
          "const bytes = readFileSync(chunkFile);",
          'const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;',
          `console.log(JSON.stringify({ ok: true, stage: "render-scene", slideNumber, file: \`${PROJECT_SCENE_CHUNK_DIR}/scene-\${slideNumber}.ts\`, byteLength: statSync(chunkFile).size, contentDigest, from, to, reused: false }));`,
        ].join("\n"),
      },
      {
        path: "scripts/render-audio.mjs",
        content: [
          'import { createHash } from "node:crypto";',
          'import { mkdirSync, readFileSync, statSync } from "node:fs";',
          'import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";',
          "",
          ...PROJECT_BROWSER_PRELUDE_LINES,
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          "const hasNarration = manifest.scenes.some((scene) => Boolean(scene.narrationFile));",
          `const output = new URL("../${PROJECT_NARRATION_AUDIO_PATH}", import.meta.url).pathname;`,
          "if (!hasNarration) {",
          '  console.log(JSON.stringify({ ok: true, stage: "render-audio", file: null, byteLength: 0, contentDigest: null }));',
          "} else {",
          "  const audioBitrate = process.env.SOURCEWEFT_AUDIO_BITRATE;",
          '  if (!audioBitrate || !/^\\d+k$/u.test(audioBitrate)) throw new Error("trusted audio bitrate is invalid");',
          '  mkdirSync(new URL("../out", import.meta.url).pathname, { recursive: true });',
          `  const serveUrl = new URL("../${PROJECT_BUNDLE_DIR}", import.meta.url).pathname;`,
          "  await ensureTrustedBrowser();",
          '  const composition = await selectComposition({ serveUrl, id: "video-presentation", ...browserOptions });',
          '  await renderMedia({ audioBitrate, codec: "aac", composition, outputLocation: output, serveUrl, ...browserOptions });',
          "  const bytes = readFileSync(output);",
          '  const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;',
          `  console.log(JSON.stringify({ ok: true, stage: "render-audio", file: ${JSON.stringify(PROJECT_NARRATION_AUDIO_PATH)}, byteLength: statSync(output).size, contentDigest }));`,
          "}",
        ].join("\n"),
      },
      {
        path: "scripts/concat-video.mjs",
        content: [
          'import { spawnSync } from "node:child_process";',
          'import { createHash } from "node:crypto";',
          'import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";',
          'import { combineChunks } from "@remotion/renderer";',
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          `mkdirSync(new URL("../${PROJECT_SCENE_CHUNK_DIR}/", import.meta.url).pathname, { recursive: true });`,
          "const videoFiles = manifest.scenes.map((scene) => {",
          `  const file = new URL(\`../${PROJECT_SCENE_CHUNK_DIR}/scene-\${scene.slideNumber}.ts\`, import.meta.url).pathname;`,
          "  if (!existsSync(file) || statSync(file).size === 0) throw new Error(`missing chunk for slide ${scene.slideNumber}: ${file}`);",
          "  return file;",
          "});",
          'if (videoFiles.length === 0) throw new Error("no scene chunks to concatenate");',
          `const audioFile = new URL("../${PROJECT_NARRATION_AUDIO_PATH}", import.meta.url).pathname;`,
          "const hasNarration = manifest.scenes.some((scene) => Boolean(scene.narrationFile));",
          'if (hasNarration && !(existsSync(audioFile) && statSync(audioFile).size > 0)) throw new Error("narrated deck is missing its rendered audio mix");',
          "const audioFiles = hasNarration ? [audioFile] : [];",
          'const temporary = new URL("../out/video.muxed.mp4", import.meta.url).pathname;',
          `const output = new URL("../${PROJECT_RENDERED_VIDEO_PATH}", import.meta.url).pathname;`,
          "rmSync(temporary, { force: true });",
          "rmSync(output, { force: true });",
          'await combineChunks({ audioCodec: "aac", audioFiles, codec: "h264", compositionDurationInFrames: manifest.durationInFrames, fps: manifest.fps, framesPerChunk: manifest.durationInFrames, outputLocation: temporary, preferLossless: false, videoFiles });',
          'const finalized = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", temporary, "-c", "copy", "-movflags", "+faststart", output], { encoding: "utf8", maxBuffer: 1024 * 1024 });',
          'if (finalized.status !== 0) throw new Error(`ffmpeg faststart failed: ${(finalized.stderr || finalized.stdout || "unknown error").slice(0, 1000)}`);',
          "rmSync(temporary, { force: true });",
          "const bytes = readFileSync(output);",
          'const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;',
          `console.log(JSON.stringify({ ok: true, stage: "render-video", file: ${JSON.stringify(PROJECT_RENDERED_VIDEO_PATH)}, byteLength: bytes.byteLength, contentDigest, durationInFrames: manifest.durationInFrames, fps: manifest.fps, width: manifest.width, height: manifest.height, hasAudio: hasNarration, sceneCount: videoFiles.length }));`,
        ].join("\n"),
      },
    ]);
  return { ...base, files, validationSamples };
}
