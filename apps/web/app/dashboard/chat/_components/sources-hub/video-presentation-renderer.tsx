"use client";

import React, { useMemo } from "react";
import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  videoPresentationSpecSchema,
  type VideoPresentationAudioTrack,
  type VideoPresentationSpec,
} from "@sourceweft/contracts/video-presentation";
import { normalizeWebAssetUrl } from "../artifact-urls";

export const VIDEO_PRESENTATION_AUDIO_DELAY_RENDER_TIMEOUT_MS = 120_000;

type RenderableVideoPresentationAudioTrack = VideoPresentationAudioTrack & {
  renderSrc?: string;
};

export type RenderableVideoPresentationSpec = Omit<
  VideoPresentationSpec,
  "audioTracks"
> & {
  audioTracks: RenderableVideoPresentationAudioTrack[];
};

type Css = React.CSSProperties;

function opacity(hex: string, alpha: number) {
  const normalized = hex.trim();
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) {
    return normalized;
  }
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseHex(hex: string) {
  const normalized = hex.trim();
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) {
    return null;
  }
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function luminance(hex: string) {
  const rgb = parseHex(hex);
  if (!rgb) {
    return 0.2;
  }
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function isLightTheme(spec: RenderableVideoPresentationSpec) {
  return luminance(spec.theme.background) > 0.62;
}

function isChalkTheme(spec: RenderableVideoPresentationSpec) {
  const background = parseHex(spec.theme.background);
  if (!background) {
    return false;
  }
  return background.g > background.r && background.g >= background.b;
}

function surfaceBackground(spec: RenderableVideoPresentationSpec, alpha = 0.08) {
  return isLightTheme(spec)
    ? opacity(spec.theme.foreground, alpha)
    : opacity(spec.theme.foreground, Math.max(alpha, 0.07));
}

function accentSurface(spec: RenderableVideoPresentationSpec, alpha = 0.16) {
  return isLightTheme(spec)
    ? opacity(spec.theme.accent, alpha)
    : opacity(spec.theme.accent, alpha + 0.04);
}

function splitMarkdown(value: string | undefined) {
  if (!value) return [];
  return value
    .split(/\n+|(?:^|\s)[-*]\s+/g)
    .map((line) =>
      line
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
        .replace(/\s*\[\s*citation:[^\]]+]\s*/gi, " ")
        .replace(/\s*【\s*citation:[^】]+】\s*/gi, " ")
        .replace(/\s*\(\s*citation:[^)]+\)\s*/gi, " ")
        .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^\s{0,3}#{1,6}\s*/gm, "")
        .replace(/(^|\s)#{1,6}\s+/g, "$1")
        .replace(/^\s{0,3}>\s?/gm, "")
        .replace(/^\s*\d+[.)]\s+/gm, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 5);
}

export function parseVideoPresentationSpec(
  value: unknown,
): RenderableVideoPresentationSpec | null {
  const result = videoPresentationSpecSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function estimateNarrationDurationSeconds(text: string) {
  const compacted = text.replace(/\s+/g, " ").trim().slice(0, 10_000);
  if (!compacted) {
    return 5;
  }
  const cjkChars = compacted.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const latinWords =
    compacted.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;
  const punctuationPauses =
    compacted.match(/[.!?。！？;；:：]/gu)?.length ?? 0;
  const byCjk = cjkChars / 4.8;
  const byWords = latinWords / 2.55;
  const estimated = Math.max(byCjk, byWords) + punctuationPauses * 0.25 + 1.2;
  return Math.min(48, Math.max(4.5, Number(estimated.toFixed(2))));
}

export function getAudioTrackForSlide(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
) {
  return spec.audioTracks.find((track) => track.slideNumber === slideNumber);
}

function resolveAudioTrackSrc(track: RenderableVideoPresentationAudioTrack) {
  return track.renderSrc ?? normalizeWebAssetUrl(track.assetUrl);
}

export function getSlideDurationSeconds(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
) {
  const track = getAudioTrackForSlide(spec, slideNumber);
  if (track?.durationSeconds && track.durationSeconds > 0) {
    return Math.max(4.5, track.durationSeconds + 0.85);
  }
  const slide = spec.slides.find(
    (candidate) => candidate.slideNumber === slideNumber,
  );
  const text =
    slide?.speakerTranscript
      .join(" ")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\s*\[\s*citation:[^\]]+]\s*/gi, " ")
      .replace(/\s*【\s*citation:[^】]+】\s*/gi, " ")
      .replace(/\s*\(\s*citation:[^)]+\)\s*/gi, " ")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s*/gm, "")
      .replace(/(^|\s)#{1,6}\s+/g, "$1")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/\s+/g, " ")
      .trim() ?? "";
  return estimateNarrationDurationSeconds(text) + 0.85;
}

export function getSlideDurationInFrames(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
) {
  return Math.max(
    1,
    Math.ceil(getSlideDurationSeconds(spec, slideNumber) * spec.fps),
  );
}

export function getVideoDurationInFrames(
  spec: RenderableVideoPresentationSpec,
) {
  return spec.slides.reduce(
    (sum, slide) => sum + getSlideDurationInFrames(spec, slide.slideNumber),
    0,
  );
}

export function getVideoDurationSeconds(
  spec: RenderableVideoPresentationSpec,
) {
  return Number((getVideoDurationInFrames(spec) / spec.fps).toFixed(2));
}

function slideOffsetFrames(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
) {
  let offset = 0;
  for (const slide of spec.slides) {
    if (slide.slideNumber >= slideNumber) {
      break;
    }
    offset += getSlideDurationInFrames(spec, slide.slideNumber);
  }
  return offset;
}

function SceneBackground({
  spec,
  progress,
}: {
  spec: RenderableVideoPresentationSpec;
  progress: number;
}) {
  const theme = spec.theme;
  const light = isLightTheme(spec);
  const chalk = isChalkTheme(spec);
  const base: Css = {
    background: chalk
      ? `linear-gradient(115deg, ${theme.background}, ${opacity(theme.secondary, 0.16)} 58%, ${theme.background})`
      : light
        ? `linear-gradient(140deg, ${theme.background}, ${opacity(theme.secondary, 0.13)} 52%, ${opacity(theme.accent, 0.12)})`
        : `linear-gradient(135deg, ${theme.background}, ${opacity(theme.secondary, 0.22)} 52%, ${opacity(theme.accent, 0.18)})`,
  };
  return (
    <AbsoluteFill style={base}>
      {light ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              `linear-gradient(0deg, ${opacity(theme.foreground, 0.045)} 1px, transparent 1px), ` +
              `linear-gradient(90deg, ${opacity(theme.foreground, 0.035)} 1px, transparent 1px)`,
            backgroundSize: "72px 72px",
            transform: `translate3d(${progress * -18}px, ${progress * -12}px, 0)`,
          }}
        />
      ) : null}
      {chalk ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              `repeating-linear-gradient(0deg, transparent 0 74px, ${opacity(theme.foreground, 0.07)} 75px 76px), ` +
              `linear-gradient(90deg, ${opacity(theme.foreground, 0.045)}, transparent 24%)`,
            opacity: 0.8,
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          inset: light || chalk ? "auto 0 0" : 0,
          height: light || chalk ? 220 : undefined,
          background:
            light || chalk
              ? `linear-gradient(0deg, ${opacity(theme.accent, 0.16)}, transparent)`
              : `linear-gradient(90deg, ${opacity(theme.foreground, 0.055)} 1px, transparent 1px), linear-gradient(0deg, ${opacity(theme.foreground, 0.04)} 1px, transparent 1px)`,
          backgroundSize: light || chalk ? undefined : "96px 96px",
          opacity: light || chalk ? 1 : 0.35,
          transform:
            light || chalk
              ? undefined
              : `translate3d(${progress * -24}px, ${progress * -18}px, 0)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: "7%",
          border: `1px solid ${opacity(theme.foreground, light ? 0.18 : 0.14)}`,
        }}
      />
    </AbsoluteFill>
  );
}

function MetricGrid({
  metrics,
  spec,
}: {
  metrics: RenderableVideoPresentationSpec["scenes"][number]["metrics"];
  spec: RenderableVideoPresentationSpec;
}) {
  const theme = spec.theme;
  const light = isLightTheme(spec);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(2, Math.max(1, metrics.length))}, minmax(0, 1fr))`,
        gap: 22,
        width: "100%",
      }}
    >
      {metrics.map((metric) => (
        <div
          key={`${metric.label}-${metric.value}`}
          style={{
            border: `1px solid ${opacity(theme.foreground, 0.16)}`,
            background: light
              ? opacity(theme.background, 0.7)
              : surfaceBackground(spec, 0.065),
            padding: "28px 30px",
          }}
        >
          <div
            style={{
              color: theme.accent,
              fontSize: 54,
              fontWeight: 760,
              letterSpacing: 0,
              lineHeight: 1,
            }}
          >
            {metric.value}
          </div>
          <div
            style={{
              marginTop: 12,
              color: theme.foreground,
              fontSize: 24,
              lineHeight: 1.25,
            }}
          >
            {metric.label}
          </div>
          {metric.delta ? (
            <div
              style={{
                marginTop: 10,
                color: theme.muted,
                fontSize: 18,
              }}
            >
              {metric.delta}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function BulletList({
  bullets,
  spec,
}: {
  bullets: string[];
  spec: RenderableVideoPresentationSpec;
}) {
  const theme = spec.theme;
  const light = isLightTheme(spec);
  const chalk = isChalkTheme(spec);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        width: "100%",
      }}
    >
      {bullets.slice(0, 5).map((bullet, index) => (
        <div
          key={`${bullet}-${index}`}
          style={{
            alignItems: "flex-start",
            background:
              light || chalk ? surfaceBackground(spec, 0.05) : undefined,
            borderLeft:
              light || chalk
                ? `4px solid ${index % 2 === 0 ? theme.accent : theme.secondary}`
                : undefined,
            color: theme.foreground,
            display: "flex",
            fontSize: 30,
            gap: 18,
            lineHeight: 1.28,
            padding: light || chalk ? "14px 18px" : undefined,
          }}
        >
          <span
            style={{
              background: index % 2 === 0 ? theme.accent : theme.secondary,
              flex: "0 0 auto",
              height: chalk ? 4 : 12,
              marginTop: chalk ? 18 : 14,
              width: light || chalk ? 28 : 36,
            }}
          />
          <span>{bullet}</span>
        </div>
      ))}
    </div>
  );
}

function Timeline({
  items,
  spec,
}: {
  items: RenderableVideoPresentationSpec["scenes"][number]["timeline"];
  spec: RenderableVideoPresentationSpec;
}) {
  const theme = spec.theme;
  const light = isLightTheme(spec);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, items.length))}, minmax(0, 1fr))`,
        gap: 20,
        width: "100%",
      }}
    >
      {items.map((item, index) => (
        <div
          key={`${item.label}-${index}`}
          style={{
            borderTop: `5px solid ${index % 2 === 0 ? theme.accent : theme.secondary}`,
            background: light
              ? opacity(theme.background, 0.72)
              : surfaceBackground(spec, 0.065),
            padding: "24px 22px",
          }}
        >
          <div
            style={{
              color: theme.foreground,
              fontSize: 25,
              fontWeight: 680,
              lineHeight: 1.18,
            }}
          >
            {item.label}
          </div>
          {item.detail ? (
            <div
              style={{
                color: theme.muted,
                fontSize: 19,
                lineHeight: 1.32,
                marginTop: 12,
              }}
            >
              {item.detail}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SceneContent({
  audioTrack,
  spec,
  slideNumber,
}: {
  audioTrack?: RenderableVideoPresentationAudioTrack;
  spec: RenderableVideoPresentationSpec;
  slideNumber: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = spec.theme;
  const scene =
    spec.scenes.find((candidate) => candidate.slideNumber === slideNumber) ??
    spec.scenes[0];
  const slide =
    spec.slides.find((candidate) => candidate.slideNumber === slideNumber) ??
    spec.slides[0];
  if (!scene || !slide) {
    return <AbsoluteFill style={{ background: theme.background }} />;
  }
  const localFrame = frame - slideOffsetFrames(spec, slideNumber);
  const reveal = spring({
    frame: localFrame,
    fps,
    config: { damping: 28, stiffness: 70, mass: 0.9 },
  });
  const progress = interpolate(
    localFrame,
    [0, getSlideDurationInFrames(spec, slideNumber)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.ease },
  );
  const bullets = scene.bullets.length
    ? scene.bullets
    : splitMarkdown(slide.contentMarkdown);
  const isTitle = scene.sceneType === "title";
  const isQuote = scene.sceneType === "quote" && scene.quote;
  const isTimeline = scene.sceneType === "timeline" && scene.timeline.length > 0;
  const isMetric = scene.sceneType === "metric" && scene.metrics.length > 0;
  const light = isLightTheme(spec);
  const chalk = isChalkTheme(spec);
  const isStacked =
    scene.composition === "stacked" || scene.sceneType === "process";
  const isDataWall =
    scene.composition === "data-wall" || scene.sceneType === "comparison";
  const isRadial = scene.composition === "radial";

  return (
    <AbsoluteFill
      style={{
        color: theme.foreground,
        fontFamily: theme.fontFamily,
        overflow: "hidden",
      }}
    >
      <SceneBackground spec={spec} progress={progress} />
      {audioTrack?.renderSrc || audioTrack?.assetUrl ? (
        <Audio
          delayRenderTimeoutInMilliseconds={
            VIDEO_PRESENTATION_AUDIO_DELAY_RENDER_TIMEOUT_MS
          }
          requestInit={{ credentials: "include" }}
          src={resolveAudioTrackSrc(audioTrack)}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          inset: "9% 9% 8%",
          display: "grid",
          gridTemplateColumns:
            scene.composition === "split" && !isTitle
              ? "1fr 0.74fr"
              : isDataWall && !isTitle
                ? "0.82fr 1fr"
                : "1fr",
          gap: isStacked || isRadial ? 42 : 70,
          alignItems: "center",
          opacity: reveal,
          transform: `translateY(${(1 - reveal) * 42}px) scale(${1 + progress * 0.018})`,
        }}
      >
        <div
          style={{
            borderTop:
              isTitle && (light || chalk)
                ? `6px solid ${theme.accent}`
                : undefined,
            maxWidth: isTitle ? 1220 : isDataWall ? 820 : 980,
            paddingTop: isTitle && (light || chalk) ? 34 : undefined,
          }}
        >
          {scene.kicker || slide.subtitle ? (
            <div
              style={{
                color: theme.accent,
                fontSize: isTitle ? 28 : 22,
                fontWeight: 720,
                letterSpacing: 0,
                marginBottom: 26,
                textTransform: "uppercase",
              }}
            >
              {scene.kicker ?? slide.subtitle}
            </div>
          ) : null}
          <div
            style={{
              color: theme.foreground,
              fontSize: isTitle
                ? 98
                : isDataWall || isStacked
                  ? 58
                  : 68,
              fontWeight: 780,
              letterSpacing: 0,
              lineHeight: isTitle ? 0.98 : 1.03,
              maxWidth: 1250,
            }}
          >
            {scene.title || slide.title}
          </div>
          {scene.subtitle && !isTitle ? (
            <div
              style={{
                color: theme.muted,
                fontSize: 30,
                lineHeight: 1.28,
                marginTop: 26,
                maxWidth: 900,
              }}
            >
              {scene.subtitle}
            </div>
          ) : null}
          {isTitle && slide.subtitle ? (
            <div
              style={{
                color: theme.muted,
                fontSize: 34,
                lineHeight: 1.32,
                marginTop: 34,
                maxWidth: 960,
              }}
            >
              {slide.subtitle}
            </div>
          ) : null}
        </div>
        <div
          style={{
            alignSelf: "center",
            justifySelf:
              scene.composition === "split" || isDataWall
                ? "stretch"
                : isRadial
                  ? "center"
                  : "start",
            transform:
              isRadial && !isTitle
                ? `rotate(${(progress - 0.5) * 1.5}deg)`
                : undefined,
            width: "100%",
          }}
        >
          {isQuote ? (
            <div
              style={{
                borderLeft: `8px solid ${theme.accent}`,
                color: theme.foreground,
                fontSize: 42,
                lineHeight: 1.22,
                paddingLeft: 34,
              }}
            >
              {scene.quote}
            </div>
          ) : isMetric ? (
            <MetricGrid metrics={scene.metrics} spec={spec} />
          ) : isTimeline ? (
            <Timeline items={scene.timeline} spec={spec} />
          ) : !isTitle && bullets.length > 0 ? (
            isRadial ? (
              <div
                style={{
                  display: "grid",
                  gap: 18,
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                }}
              >
                {bullets.slice(0, 4).map((bullet, index) => (
                  <div
                    key={`${bullet}-${index}`}
                    style={{
                      background: accentSurface(spec, 0.12),
                      border: `1px solid ${opacity(theme.foreground, light ? 0.16 : 0.12)}`,
                      color: theme.foreground,
                      fontSize: 25,
                      lineHeight: 1.24,
                      minHeight: 140,
                      padding: "24px 26px",
                    }}
                  >
                    {bullet}
                  </div>
                ))}
              </div>
            ) : (
              <BulletList bullets={bullets} spec={spec} />
            )
          ) : null}
        </div>
      </div>
      <div
        style={{
          bottom: 44,
          color: opacity(theme.foreground, 0.72),
          fontSize: 18,
          left: "9%",
          position: "absolute",
          right: "9%",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{spec.title}</span>
        <span>
          {slideNumber.toString().padStart(2, "0")} /{" "}
          {spec.slides.length.toString().padStart(2, "0")}
        </span>
      </div>
    </AbsoluteFill>
  );
}

export function VideoPresentationComposition({
  spec,
}: {
  spec: RenderableVideoPresentationSpec;
}) {
  let offset = 0;
  return (
    <AbsoluteFill style={{ background: spec.theme.background }}>
      {spec.slides.map((slide) => {
        const duration = getSlideDurationInFrames(spec, slide.slideNumber);
        const from = offset;
        offset += duration;
        return (
          <Sequence
            durationInFrames={duration}
            from={from}
            key={slide.slideNumber}
          >
            <SceneContent
              audioTrack={getAudioTrackForSlide(spec, slide.slideNumber)}
              spec={spec}
              slideNumber={slide.slideNumber}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

export function useVideoPresentationSpec(
  payload: Record<string, unknown>,
): RenderableVideoPresentationSpec | null {
  return useMemo(
    () => parseVideoPresentationSpec(payload.spec ?? payload),
    [payload],
  );
}
