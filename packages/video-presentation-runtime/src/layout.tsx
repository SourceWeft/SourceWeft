import React from "react";
import { Img, useVideoConfig } from "remotion";

/**
 * Layout primitives injected into generated scenes (browser runtime globals
 * and the sandbox project's src/scenes/layout-primitives.tsx — keep both in
 * sync; see layout-source.ts and its parity test).
 *
 * Contract: all foreground text/content lives inside exactly one <SafeArea>,
 * which owns the safe margins and clips overflow. Font sizes derive from the
 * canvas height so scenes scale across resolutions.
 */
export const SAFE_MARGIN_RATIO = 0.06;

type Children = { children?: React.ReactNode };
type Styleable = { style?: React.CSSProperties };

export function SafeArea({
  children,
  align = "flex-start",
  justify = "center",
  gap,
  style,
}: Children &
  Styleable & {
    align?: React.CSSProperties["alignItems"];
    justify?: React.CSSProperties["justifyContent"];
    gap?: number | string;
  }) {
  const { width, height } = useVideoConfig();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        ...style,
        position: "absolute",
        inset: 0,
        boxSizing: "border-box",
        overflow: "hidden",
        padding: `${Math.round(height * SAFE_MARGIN_RATIO)}px ${Math.round(width * SAFE_MARGIN_RATIO)}px`,
        alignItems: align,
        justifyContent: justify,
        ...(gap !== undefined ? { gap } : {}),
      }}
    >
      {children}
    </div>
  );
}

export function TitleBlock({
  title,
  subtitle,
  color,
  subtitleColor,
  style,
}: Styleable & {
  title: string;
  subtitle?: string;
  color?: string;
  subtitleColor?: string;
}) {
  const { height } = useVideoConfig();
  return (
    <div style={{ maxWidth: "100%", ...style }}>
      <div
        style={{
          fontSize: Math.round(height * 0.068),
          fontWeight: 700,
          lineHeight: 1.12,
          ...(color ? { color } : {}),
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            fontSize: Math.round(height * 0.032),
            lineHeight: 1.3,
            marginTop: Math.round(height * 0.018),
            opacity: 0.82,
            ...(subtitleColor ? { color: subtitleColor } : {}),
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

export function BulletList({
  items,
  color,
  markerColor,
  gap,
  style,
}: Styleable & {
  items: string[];
  color?: string;
  markerColor?: string;
  gap?: number;
}) {
  const { height } = useVideoConfig();
  const fontSize = Math.round(height * 0.032);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: gap ?? Math.round(height * 0.022),
        maxWidth: "100%",
        ...style,
      }}
    >
      {items.slice(0, 4).map((item, index) => (
        <div
          key={index}
          style={{
            alignItems: "baseline",
            display: "flex",
            fontSize,
            gap: Math.round(fontSize * 0.6),
            lineHeight: 1.35,
            ...(color ? { color } : {}),
          }}
        >
          <span
            style={{
              flexShrink: 0,
              fontSize: Math.round(fontSize * 0.72),
              ...(markerColor ? { color: markerColor } : { opacity: 0.6 }),
            }}
          >
            ●
          </span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {item}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SplitLayout({
  left,
  right,
  ratio = 0.5,
  gap,
  style,
}: Styleable & {
  left: React.ReactNode;
  right: React.ReactNode;
  ratio?: number;
  gap?: number | string;
}) {
  const { width } = useVideoConfig();
  const clamped = Math.min(0.8, Math.max(0.2, ratio));
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flexDirection: "row",
        gap: gap ?? Math.round(width * 0.03),
        height: "100%",
        maxWidth: "100%",
        width: "100%",
        ...style,
      }}
    >
      <div style={{ flex: clamped, minWidth: 0, overflow: "hidden" }}>
        {left}
      </div>
      <div style={{ flex: 1 - clamped, minWidth: 0, overflow: "hidden" }}>
        {right}
      </div>
    </div>
  );
}

export function StatHero({
  value,
  label,
  color,
  labelColor,
  style,
}: Styleable & {
  value: string;
  label?: string;
  color?: string;
  labelColor?: string;
}) {
  const { height } = useVideoConfig();
  return (
    <div style={{ maxWidth: "100%", textAlign: "center", ...style }}>
      <div
        style={{
          fontSize: Math.round(height * 0.16),
          fontWeight: 800,
          lineHeight: 1.05,
          ...(color ? { color } : {}),
        }}
      >
        {value}
      </div>
      {label ? (
        <div
          style={{
            fontSize: Math.round(height * 0.034),
            lineHeight: 1.3,
            marginTop: Math.round(height * 0.02),
            opacity: 0.82,
            ...(labelColor ? { color: labelColor } : {}),
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
}

export function QuoteBlock({
  quote,
  attribution,
  color,
  style,
}: Styleable & {
  quote: string;
  attribution?: string;
  color?: string;
}) {
  const { height } = useVideoConfig();
  return (
    <div style={{ maxWidth: "88%", ...style }}>
      <div
        style={{
          fontSize: Math.round(height * 0.048),
          fontStyle: "italic",
          fontWeight: 500,
          lineHeight: 1.28,
          ...(color ? { color } : {}),
        }}
      >
        “{quote}”
      </div>
      {attribution ? (
        <div
          style={{
            fontSize: Math.round(height * 0.028),
            marginTop: Math.round(height * 0.024),
            opacity: 0.75,
          }}
        >
          — {attribution}
        </div>
      ) : null}
    </div>
  );
}

export function AssetImage({
  src,
  rounded = true,
  style,
}: Styleable & {
  src: string;
  rounded?: boolean;
}) {
  const { height } = useVideoConfig();
  return (
    <Img
      src={src}
      style={{
        maxWidth: "100%",
        maxHeight: "100%",
        objectFit: "cover",
        ...(rounded ? { borderRadius: Math.round(height * 0.022) } : {}),
        ...style,
      }}
    />
  );
}

export const VIDEO_LAYOUT_PRIMITIVE_NAMES = [
  "SafeArea",
  "TitleBlock",
  "BulletList",
  "SplitLayout",
  "StatHero",
  "QuoteBlock",
  "AssetImage",
] as const;
