import { VIDEO_LAYOUT_PRIMITIVES_TSX } from "@sourceweft/video-presentation-runtime/layout-source";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";
import { VIDEO_SCENE_COMPONENT_NAME } from "./config";
import { normalizeSceneProjectCode } from "./scene-gen";

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
  payload: VideoPresentationProjectPayload,
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
        path: "src/index.ts",
        content: [
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
            scripts: {
              build: "tsc -p tsconfig.json --noEmit",
              "render-smoke": "node scripts/render-smoke.mjs",
              "render-stills": "node scripts/render-stills.mjs",
              // The mp4 is produced by N+2 commands, never one: one per scene,
              // one for the narration mix, one to join them. See the scripts
              // themselves for why it is split that way.
              "render-scene": "node scripts/render-scene.mjs",
              "render-audio": "node scripts/render-audio.mjs",
              "concat-video": "node scripts/concat-video.mjs",
            },
            dependencies: {
              remotion: "^4.0.0",
              react: "^18.3.1",
              "react-dom": "^18.3.1",
            },
            devDependencies: {
              "@types/react": "^18.3.18",
              "@types/react-dom": "^18.3.5",
              typescript: "^5.9.2",
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
        // slide's speech in the browser preview as well as in the mp4, so
        // there is no degraded-but-honest output left to fall back to.
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
      {
        // Renders one mid-narration frame per slide for the visual QA stage.
        // Infra failures (no chromium in the sandbox image, bundle errors)
        // exit non-zero; the worker treats that as "skip visual QA", never as
        // a pipeline failure.
        path: "scripts/render-stills.mjs",
        content: [
          'import { mkdirSync, readFileSync } from "node:fs";',
          'import { bundle } from "@remotion/bundler";',
          'import { ensureBrowser, renderStill, selectComposition } from "@remotion/renderer";',
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          "await ensureBrowser();",
          'const serveUrl = await bundle({ entryPoint: new URL("../src/index.ts", import.meta.url).pathname });',
          'const composition = await selectComposition({ serveUrl, id: "video-presentation" });',
          'mkdirSync(new URL("../out", import.meta.url), { recursive: true });',
          "let frameCursor = 0;",
          "const rendered = [];",
          "for (const scene of manifest.scenes) {",
          "  const frame = Math.min(composition.durationInFrames - 1, frameCursor + Math.floor(scene.durationInFrames / 2));",
          "  const output = new URL(`../out/slide-${scene.slideNumber}.jpeg`, import.meta.url).pathname;",
          '  await renderStill({ composition, serveUrl, frame, output, imageFormat: "jpeg", jpegQuality: 80 });',
          "  rendered.push({ slideNumber: scene.slideNumber, frame, file: `out/slide-${scene.slideNumber}.jpeg` });",
          "  frameCursor += scene.durationInFrames;",
          "}",
          'console.log(JSON.stringify({ ok: true, stage: "render-stills", rendered }));',
        ].join("\n"),
      },
      {
        // Renders ONE scene to a video chunk with @remotion/renderer — the same
        // server-side renderer the stills path already proves works in the
        // sandbox. This is the execution site the browser `new Function` scene
        // compiler is meant to be replaced by: model-authored scene code only
        // ever runs here, behind the sandbox boundary.
        //
        // Why one scene per invocation and not the whole composition: every
        // sandbox command is killed at `SOURCEWEFT_SANDBOX_COMMAND_TIMEOUT_MS`
        // (120s) and that limit is deliberately not being raised. A whole-deck
        // render blows through it; a single scene is the largest unit that
        // plausibly fits. The split is not an optimisation, it is the only
        // thing that keeps each command inside the budget.
        //
        // Chunks are rendered muted: narration is mixed once by `render-audio`
        // (see PROJECT_NARRATION_AUDIO_PATH for why per-scene audio chunks
        // would be stitched at the wrong offsets).
        //
        // Dormant until something invokes `pnpm run render-scene`; the pipeline
        // stages as they stand never do.
        path: "scripts/render-scene.mjs",
        content: [
          'import { createHash } from "node:crypto";',
          'import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";',
          'import { bundle } from "@remotion/bundler";',
          'import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";',
          "",
          "const slideNumber = Number(process.argv[2]);",
          "if (!Number.isInteger(slideNumber)) {",
          "  throw new Error(`render-scene expects a slide number, got ${JSON.stringify(process.argv[2])}`);",
          "}",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          "// The scene's frame range inside the single composition: scenes are laid",
          "// out back to back by VideoScene, so the offset is the sum of every",
          "// earlier scene's duration. Rendering a frameRange of the real",
          "// composition (rather than a per-scene composition) is what keeps every",
          "// chunk encoded with identical parameters, which is what makes the",
          "// concat a stream copy instead of a re-encode.",
          "let from = 0;",
          "let scene = null;",
          "for (const entry of manifest.scenes) {",
          "  if (entry.slideNumber === slideNumber) {",
          "    scene = entry;",
          "    break;",
          "  }",
          "  from += entry.durationInFrames;",
          "}",
          "if (!scene) {",
          "  throw new Error(`no scene for slide ${slideNumber}`);",
          "}",
          "// Remotion's frameRange end is inclusive.",
          "const to = from + scene.durationInFrames - 1;",
          `const chunkDir = new URL("../${PROJECT_SCENE_CHUNK_DIR}/", import.meta.url).pathname;`,
          "mkdirSync(chunkDir, { recursive: true });",
          "const chunkFile = `${chunkDir}scene-${slideNumber}.ts`;",
          "const sidecarFile = `${chunkDir}scene-${slideNumber}.json`;",
          "// Resumability: chunks survive on the sandbox filesystem between",
          "// commands, so a rerun after a mid-deck failure re-renders only what is",
          "// missing. The sidecar records the exact scene source and frame range a",
          "// chunk was produced from, so an edited scene is never silently reused.",
          'const digest = createHash("sha256").update(readFileSync(new URL(`../${scene.file}`, import.meta.url))).digest("hex");',
          "const sidecar = JSON.stringify({ digest, from, to });",
          "const reused =",
          "  existsSync(chunkFile) &&",
          "  existsSync(sidecarFile) &&",
          "  statSync(chunkFile).size > 0 &&",
          '  readFileSync(sidecarFile, "utf8") === sidecar;',
          "if (!reused) {",
          "  // Bundling resolves staticFile() against publicDir; create it even when",
          "  // there is no narration so the bundler never trips over a missing path.",
          '  const publicDir = new URL("../public", import.meta.url).pathname;',
          "  mkdirSync(publicDir, { recursive: true });",
          "  await ensureBrowser();",
          `  const serveUrl = await bundle({ entryPoint: new URL("../src/index.ts", import.meta.url).pathname, publicDir, outDir: new URL("../${PROJECT_BUNDLE_DIR}", import.meta.url).pathname });`,
          '  const composition = await selectComposition({ serveUrl, id: "video-presentation" });',
          "  // Concurrency is left at the renderer's default (derived from the",
          "  // sandbox's own CPU count) rather than pinned here: the sandbox owns its",
          "  // resource budget and this script must not widen it.",
          "  await renderMedia({",
          '    codec: "h264-ts",',
          "    composition,",
          "    frameRange: [from, to],",
          "    muted: true,",
          "    outputLocation: chunkFile,",
          "    serveUrl,",
          "  });",
          "  writeFileSync(sidecarFile, sidecar);",
          "}",
          `console.log(JSON.stringify({ ok: true, stage: "render-scene", slideNumber, file: \`${PROJECT_SCENE_CHUNK_DIR}/scene-\${slideNumber}.ts\`, byteLength: statSync(chunkFile).size, from, to, reused }));`,
        ].join("\n"),
      },
      {
        // Renders the narration for the WHOLE composition in one pass, to a
        // single aac file. This is the one remaining whole-deck command, and it
        // is affordable because an audio-only render rasterises no frames — the
        // browser only has to evaluate the timeline to collect audio assets.
        //
        // It is skipped entirely when the deck has no narration.
        path: "scripts/render-audio.mjs",
        content: [
          'import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";',
          'import { bundle } from "@remotion/bundler";',
          'import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";',
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          "const hasNarration = manifest.scenes.some((scene) => Boolean(scene.narrationFile));",
          `const output = new URL("../${PROJECT_NARRATION_AUDIO_PATH}", import.meta.url).pathname;`,
          "if (!hasNarration) {",
          `  console.log(JSON.stringify({ ok: true, stage: "render-audio", file: null, byteLength: 0, reused: false }));`,
          "} else {",
          "  // Same resume rule as the scene chunks: an audio mix already on disk is",
          "  // reused, so a retry after a failed scene does not re-render it.",
          "  const reused = existsSync(output) && statSync(output).size > 0;",
          "  if (!reused) {",
          '    const publicDir = new URL("../public", import.meta.url).pathname;',
          "    mkdirSync(publicDir, { recursive: true });",
          '    mkdirSync(new URL("../out", import.meta.url).pathname, { recursive: true });',
          "    await ensureBrowser();",
          `    const serveUrl = await bundle({ entryPoint: new URL("../src/index.ts", import.meta.url).pathname, publicDir, outDir: new URL("../${PROJECT_BUNDLE_DIR}", import.meta.url).pathname });`,
          '    const composition = await selectComposition({ serveUrl, id: "video-presentation" });',
          "    await renderMedia({",
          '      codec: "aac",',
          "      composition,",
          "      outputLocation: output,",
          "      serveUrl,",
          "    });",
          "  }",
          `  console.log(JSON.stringify({ ok: true, stage: "render-audio", file: ${JSON.stringify(PROJECT_NARRATION_AUDIO_PATH)}, byteLength: statSync(output).size, reused }));`,
          "}",
        ].join("\n"),
      },
      {
        // Joins the per-scene chunks (and the narration mix, if any) into the
        // deliverable mp4 with @remotion/renderer's `combineChunks` — the same
        // primitive Remotion Lambda uses to stitch its distributed chunks.
        //
        // For an h264 output `combineChunks` concatenates video with ffmpeg's
        // `concat:` protocol and `-c:v copy`: a stream copy, no re-encode, which
        // is only sound because every chunk came from one frameRange of one
        // composition and so shares codec, resolution, fps and encoder settings.
        // That also makes this command cheap — it is I/O, not encoding — so it
        // is not a realistic threat to the 120s command budget even for long decks.
        //
        // `framesPerChunk` describes the *audio* chunking, not the video: audio
        // arrives as one file covering the whole composition, so the chunk
        // length is the composition length. Passing the per-scene lengths here
        // is impossible (the option is a single number) and would be wrong.
        //
        // Refuses to emit anything if a chunk is missing: a short video that
        // looks complete is worse than no video.
        path: "scripts/concat-video.mjs",
        content: [
          'import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";',
          'import { combineChunks } from "@remotion/renderer";',
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          `mkdirSync(new URL("../${PROJECT_SCENE_CHUNK_DIR}/", import.meta.url).pathname, { recursive: true });`,
          "const videoFiles = manifest.scenes.map((scene) => {",
          `  const file = new URL(\`../${PROJECT_SCENE_CHUNK_DIR}/scene-\${scene.slideNumber}.ts\`, import.meta.url).pathname;`,
          "  if (!existsSync(file) || statSync(file).size === 0) {",
          "    throw new Error(`missing chunk for slide ${scene.slideNumber}: ${file}`);",
          "  }",
          "  return file;",
          "});",
          "if (videoFiles.length === 0) {",
          '  throw new Error("no scene chunks to concatenate");',
          "}",
          `const audioFile = new URL("../${PROJECT_NARRATION_AUDIO_PATH}", import.meta.url).pathname;`,
          "const hasNarration = manifest.scenes.some((scene) => Boolean(scene.narrationFile));",
          "if (hasNarration && !(existsSync(audioFile) && statSync(audioFile).size > 0)) {",
          '  throw new Error("narrated deck is missing its rendered audio mix");',
          "}",
          "const audioFiles = hasNarration ? [audioFile] : [];",
          `const output = new URL("../${PROJECT_RENDERED_VIDEO_PATH}", import.meta.url).pathname;`,
          "await combineChunks({",
          '  audioCodec: "aac",',
          "  audioFiles,",
          '  codec: "h264",',
          "  compositionDurationInFrames: manifest.durationInFrames,",
          "  fps: manifest.fps,",
          "  framesPerChunk: manifest.durationInFrames,",
          "  outputLocation: output,",
          "  preferLossless: false,",
          "  videoFiles,",
          "});",
          "const stats = statSync(output);",
          `console.log(JSON.stringify({ ok: true, stage: "render-video", file: ${JSON.stringify(PROJECT_RENDERED_VIDEO_PATH)}, byteLength: stats.size, durationInFrames: manifest.durationInFrames, fps: manifest.fps, width: manifest.width, height: manifest.height, hasAudio: hasNarration, sceneCount: videoFiles.length }));`,
        ].join("\n"),
      },
    ],
  };
}
