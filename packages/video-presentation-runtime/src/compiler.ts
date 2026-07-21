import React from "react";
import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";
import {
  createPlaceholderCompiledScene,
  type CompiledVideoPresentationScene,
} from "./react";
import { getAudioTrackForSlide, getSlideDurationInFrames } from "./model";
import * as layoutPrimitives from "./layout";
import { VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES } from "./layout-source";

type SceneRuntimeGlobals = Record<string, unknown>;

type BabelStandalone = {
  transform: (
    code: string,
    options: {
      filename?: string;
      presets?: string[];
    },
  ) => {
    code?: string | null;
  };
};

export type VideoPresentationSceneCompileDiagnostic = {
  errorMessage: string;
  slideNumber: number;
  title: string;
};

export type CompileVideoPresentationScenesResult = {
  diagnostics: VideoPresentationSceneCompileDiagnostic[];
  scenes: CompiledVideoPresentationScene[];
};

function stripImportsAndExports(code: string) {
  return code
    .replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/g, "function $1")
    .replace(/export\s+default\s+([A-Za-z_$][\w$]*);?/g, "exports.default = $1;")
    .replace(/export\s+\{[^}]*\};?/g, "");
}

function sceneRuntimeGlobals(): SceneRuntimeGlobals {
  return {
    AbsoluteFill,
    Audio,
    Img,
    React,
    interpolate,
    spring,
    staticFile,
    useCurrentFrame,
    useVideoConfig,
    ...Object.fromEntries(
      VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES.map((name) => [
        name,
        (layoutPrimitives as Record<string, unknown>)[name],
      ]),
    ),
  };
}

function evaluateSceneModule(
  code: string,
  componentName: string,
): React.ComponentType<Record<string, unknown>> {
  const globals = sceneRuntimeGlobals();
  const globalNames = Object.keys(globals);
  const globalValues = Object.values(globals);
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const wrappedCode = `${stripImportsAndExports(code)}

if (typeof ${componentName} !== "undefined") {
  exports.default = ${componentName};
}`;
  const factory = new Function(
    "exports",
    "module",
    ...globalNames,
    wrappedCode,
  );
  factory(exports, module, ...globalValues);
  const exportedDefault =
    (module.exports as Record<string, unknown>).default ?? exports.default;
  if (typeof exportedDefault !== "function") {
    throw new Error(`Scene module did not export ${componentName}.`);
  }
  return exportedDefault as React.ComponentType<Record<string, unknown>>;
}

export async function compileSceneModuleOnBrowser(
  code: string,
  componentName: string,
) {
  const babelPackageName = "@babel/standalone";
  const babel = (await import(babelPackageName)) as BabelStandalone;
  const transformed = babel.transform(code, {
    filename: `${componentName}.tsx`,
    presets: ["react", "typescript"],
  }).code;
  if (!transformed) {
    throw new Error("Scene compiler returned empty output.");
  }
  return evaluateSceneModule(transformed, componentName);
}

export async function compileVideoPresentationScenesOnBrowser(
  payload: VideoPresentationProjectPayload,
  input: {
    resolveAudioUrl?: (assetUrl: string) => string;
    useFallbackForFailedScenes?: boolean;
  } = {},
): Promise<CompileVideoPresentationScenesResult> {
  const diagnostics: VideoPresentationSceneCompileDiagnostic[] = [];
  const scenes: CompiledVideoPresentationScene[] = [];

  for (const scene of payload.sceneModules) {
    if (!scene) {
      continue;
    }
    const audioTrack = getAudioTrackForSlide(payload, scene.slideNumber);
    try {
      scenes.push({
        slideNumber: scene.slideNumber,
        component: await compileSceneModuleOnBrowser(
          scene.code,
          scene.componentName,
        ),
        durationInFrames: getSlideDurationInFrames(payload, scene.slideNumber),
        title: scene.title,
        audioUrl:
          audioTrack?.assetUrl && input.resolveAudioUrl
            ? input.resolveAudioUrl(audioTrack.assetUrl)
            : audioTrack?.assetUrl,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown scene compile error";
      diagnostics.push({
        errorMessage: message,
        slideNumber: scene.slideNumber,
        title: scene.title,
      });
      if (input.useFallbackForFailedScenes) {
        scenes.push(createPlaceholderCompiledScene(payload, scene.slideNumber));
      } else {
        throw error;
      }
    }
  }

  return { diagnostics, scenes };
}
