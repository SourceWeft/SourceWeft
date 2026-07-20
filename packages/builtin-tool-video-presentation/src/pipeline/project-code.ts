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
};

/** Directory (relative to the project root) narration is staged into. */
export const PROJECT_NARRATION_DIR = "public/audio";

/** Where `render-video` writes the mp4, relative to the project root. */
export const PROJECT_RENDERED_VIDEO_PATH = "out/video.mp4";

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
              "render-video": "node scripts/render-video.mjs",
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
              audioDurationSeconds:
                payload.audioTracks.find(
                  (track) => track.slideNumber === scene.slideNumber,
                )?.durationSeconds ?? null,
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
        path: "scripts/render-smoke.mjs",
        content: [
          'import { existsSync, readFileSync } from "node:fs";',
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
          "  if (typeof scene.audioDurationSeconds === \"number\" && scene.durationInFrames < Math.ceil(scene.audioDurationSeconds * manifest.fps)) {",
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
        // Renders the whole composition to an mp4 with @remotion/renderer, the
        // same server-side renderer the stills path already proves works in the
        // sandbox. This is the execution site the browser `new Function` scene
        // compiler is meant to be replaced by: model-authored scene code only
        // ever runs here, behind the sandbox boundary.
        //
        // It is dormant until something invokes `pnpm run render-video`; the
        // pipeline stages as they stand never do.
        path: "scripts/render-video.mjs",
        content: [
          'import { mkdirSync, readFileSync, statSync } from "node:fs";',
          'import { bundle } from "@remotion/bundler";',
          'import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";',
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          "// Bundling resolves staticFile() against publicDir; create it even when",
          "// there is no narration so the bundler never trips over a missing path.",
          'const publicDir = new URL("../public", import.meta.url).pathname;',
          "mkdirSync(publicDir, { recursive: true });",
          "await ensureBrowser();",
          'const serveUrl = await bundle({ entryPoint: new URL("../src/index.ts", import.meta.url).pathname, publicDir });',
          'const composition = await selectComposition({ serveUrl, id: "video-presentation" });',
          'mkdirSync(new URL("../out", import.meta.url), { recursive: true });',
          `const output = new URL("../${PROJECT_RENDERED_VIDEO_PATH}", import.meta.url).pathname;`,
          "// Concurrency is left at the renderer's default (derived from the",
          "// sandbox's own CPU count) rather than pinned here: the sandbox owns its",
          "// resource budget and this script must not widen it.",
          "await renderMedia({",
          '  codec: "h264",',
          "  composition,",
          "  outputLocation: output,",
          "  serveUrl,",
          "});",
          "const stats = statSync(output);",
          `console.log(JSON.stringify({ ok: true, stage: "render-video", file: ${JSON.stringify(PROJECT_RENDERED_VIDEO_PATH)}, byteLength: stats.size, durationInFrames: composition.durationInFrames, fps: composition.fps, width: composition.width, height: composition.height, hasAudio: manifest.scenes.some((scene) => Boolean(scene.narrationFile)) }));`,
        ].join("\n"),
      },
    ],
  };
}
