import React from "react";
import { Audio } from "@remotion/media";
import { Player } from "@remotion/player";
import { AbsoluteFill, Sequence } from "remotion";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";
import {
  getAudioTrackForSlide,
  getSlideDurationInFrames,
  getVideoDurationInFrames,
} from "./model";

export type CompiledVideoPresentationScene = {
  slideNumber: number;
  component: React.ComponentType<Record<string, unknown>>;
  durationInFrames: number;
  title: string;
  audioUrl?: string;
};

export type RuntimeSceneModuleExports = {
  default?: React.ComponentType<Record<string, unknown>>;
  [key: string]: unknown;
};

export function buildCompiledScenes(
  payload: VideoPresentationProjectPayload,
  input: {
    compile: (
      sceneCode: string,
      componentName: string,
      slideNumber: number,
    ) => React.ComponentType<Record<string, unknown>>;
    resolveAudioUrl?: (assetUrl: string) => string;
  },
) {
  return payload.sceneModules.map((scene) => {
    const audioTrack = getAudioTrackForSlide(payload, scene.slideNumber);
    return {
      slideNumber: scene.slideNumber,
      component: input.compile(
        scene.code,
        scene.componentName,
        scene.slideNumber,
      ),
      durationInFrames: getSlideDurationInFrames(payload, scene.slideNumber),
      title: scene.title,
      audioUrl:
        audioTrack?.assetUrl && input.resolveAudioUrl
          ? input.resolveAudioUrl(audioTrack.assetUrl)
          : audioTrack?.assetUrl,
    } satisfies CompiledVideoPresentationScene;
  });
}

function CombinedComposition({
  scenes,
}: {
  scenes: CompiledVideoPresentationScene[];
}) {
  let offset = 0;

  return (
    <AbsoluteFill>
      {scenes.map((scene) => {
        const from = offset;
        offset += scene.durationInFrames;
        const Scene = scene.component;
        return (
          <Sequence
            key={`${scene.slideNumber}-${scene.title}`}
            from={from}
            durationInFrames={scene.durationInFrames}
          >
            <Scene />
            {scene.audioUrl ? <Audio src={scene.audioUrl} /> : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

export function VideoPresentationComposition({
  scenes,
}: {
  scenes: CompiledVideoPresentationScene[];
}) {
  return <CombinedComposition scenes={scenes} />;
}

export function buildVideoPresentationComposition(
  scenes: CompiledVideoPresentationScene[],
) {
  const snapshot = [...scenes];
  return function VideoPresentationComposition() {
    return <CombinedComposition scenes={snapshot} />;
  };
}

function RuntimePlaceholderScene({
  title,
  slideNumber,
}: {
  title: string;
  slideNumber: number;
}) {
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        background:
          "radial-gradient(circle at top, rgba(56,189,248,0.2), transparent 38%), #081018",
        color: "#f8fafc",
        display: "flex",
        fontFamily:
          '"Geist Variable", "Noto Sans SC Variable", system-ui, sans-serif',
        justifyContent: "center",
        padding: 64,
      }}
    >
      <div
        style={{
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 28,
          maxWidth: 980,
          padding: "32px 36px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            color: "rgba(248,250,252,0.72)",
            fontSize: 22,
            letterSpacing: "0.08em",
            marginBottom: 18,
            textTransform: "uppercase",
          }}
        >
          Slide {slideNumber}
        </div>
        <div style={{ fontSize: 52, fontWeight: 700, lineHeight: 1.1 }}>
          {title}
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function createPlaceholderCompiledScenes(
  payload: VideoPresentationProjectPayload,
): CompiledVideoPresentationScene[] {
  return payload.slides.map((slide) =>
    createPlaceholderCompiledScene(payload, slide.slideNumber),
  );
}

export function createPlaceholderCompiledScene(
  payload: VideoPresentationProjectPayload,
  slideNumber: number,
): CompiledVideoPresentationScene {
  const slide =
    payload.slides.find((candidate) => candidate.slideNumber === slideNumber) ??
    payload.slides[0];
  const title = slide?.title ?? `Slide ${slideNumber}`;
  return {
    slideNumber,
    component: () => (
      <RuntimePlaceholderScene slideNumber={slideNumber} title={title} />
    ),
    durationInFrames: getSlideDurationInFrames(payload, slideNumber),
    title,
    audioUrl: getAudioTrackForSlide(payload, slideNumber)?.assetUrl,
  };
}

export function VideoPresentationPlayer(input: {
  payload: VideoPresentationProjectPayload;
  scenes: CompiledVideoPresentationScene[];
  className?: string;
}) {
  return (
    <Player
      className={input.className}
      component={VideoPresentationComposition}
      compositionHeight={input.payload.project.height}
      compositionWidth={input.payload.project.width}
      controls
      durationInFrames={getVideoDurationInFrames(input.payload)}
      fps={input.payload.project.fps}
      inputProps={{ scenes: input.scenes }}
      style={{
        aspectRatio: `${input.payload.project.width} / ${input.payload.project.height}`,
        maxWidth: "100%",
      }}
    />
  );
}
