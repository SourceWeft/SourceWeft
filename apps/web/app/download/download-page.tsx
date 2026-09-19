"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Laptop,
  Tag,
} from "lucide-react";

import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import {
  useLandingAuthState,
  type LandingAuthState,
} from "../_landing/components/use-landing-auth-state";
import {
  GITHUB_RELEASES_URL,
  findArtifact,
  formatArtifactSize,
  type DownloadArtifact,
  type DownloadChannel,
  type DownloadChannelManifest,
  type DownloadChannels,
} from "../../lib/download-channels";
import {
  isMobilePlatform,
  type DetectedPlatform,
} from "../../lib/detect-platform";
import { useDetectedPlatform } from "../../lib/use-detected-platform";
import {
  DESKTOP_HIGHLIGHTS,
  MOBILE_PLATFORMS,
  STORE_LINKS,
  platformDisplay,
} from "./download-content";
import {
  AllDownloadsSection,
  BeforeInstallSection,
  DesktopScreensSection,
  DownloadFaqSection,
  EverywhereSection,
  MobileSection,
  PLATFORM_ICONS,
} from "./download-sections";

const primaryButtonClassName =
  "inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100";
const secondaryButtonClassName =
  "inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-5 py-2.5 text-sm text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5";

/** The build offered by the hero button for a detected platform. Prefers the
 * architecture that currently ships, falling back to any build for the OS. */
export function primaryArtifactFor(
  manifest: DownloadChannelManifest | null,
  platform: DetectedPlatform,
): DownloadArtifact | null {
  switch (platform) {
    case "macos":
      return (
        findArtifact(manifest, "macos", "arm64") ??
        findArtifact(manifest, "macos")
      );
    case "windows":
      return (
        findArtifact(manifest, "windows", "x64") ??
        findArtifact(manifest, "windows")
      );
    case "linux":
      return findArtifact(manifest, "linux");
    default:
      return null;
  }
}

function PrimaryCta({
  manifest,
  platform,
  webHref,
  webLabel,
}: {
  manifest: DownloadChannelManifest | null;
  platform: DetectedPlatform;
  webHref: string;
  webLabel: string;
}) {
  const artifact = primaryArtifactFor(manifest, platform);

  if (isMobilePlatform(platform)) {
    const store = MOBILE_PLATFORMS.find((entry) => entry.id === platform);
    const storeHref = store ? STORE_LINKS[store.id] : undefined;
    if (store && storeHref) {
      return (
        <>
          <a
            href={storeHref}
            target="_blank"
            rel="noopener noreferrer"
            className={primaryButtonClassName}
          >
            <Download className="size-4" />
            {store.storeAction}
          </a>
          <Link href={webHref} className={secondaryButtonClassName}>
            {webLabel}
            <ArrowRight className="size-4" />
          </Link>
        </>
      );
    }
    return (
      <>
        <Link href={webHref} className={primaryButtonClassName}>
          {webLabel}
          <ArrowRight className="size-4" />
        </Link>
        <a href="#mobile" className={secondaryButtonClassName}>
          Mobile apps
          <ArrowDown className="size-4" />
        </a>
        <p className="w-full text-xs text-zinc-500 dark:text-zinc-500">
          The {store?.label ?? "mobile"} app is coming soon. The web app works
          on your phone today.
        </p>
      </>
    );
  }

  if (artifact) {
    const display = platformDisplay(artifact.platform);
    const Icon = PLATFORM_ICONS[artifact.platform];
    return (
      <>
        <a
          href={artifact.url}
          download={artifact.filename}
          rel="noopener"
          className={primaryButtonClassName}
        >
          <Icon className="size-4" />
          Download for {display.label}
        </a>
        <a href="#all-downloads" className={secondaryButtonClassName}>
          All downloads
          <ArrowDown className="size-4" />
        </a>
        <p className="w-full text-xs text-zinc-500 dark:text-zinc-500">
          {display.archLabels[artifact.arch]} · {display.fileType} ·{" "}
          {formatArtifactSize(artifact.size)}
        </p>
      </>
    );
  }

  if (manifest) {
    return (
      <>
        <a href="#all-downloads" className={primaryButtonClassName}>
          <Download className="size-4" />
          Choose your platform
        </a>
        <Link href={webHref} className={secondaryButtonClassName}>
          {webLabel}
          <ArrowRight className="size-4" />
        </Link>
      </>
    );
  }

  return (
    <>
      <a
        href={GITHUB_RELEASES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={primaryButtonClassName}
      >
        View releases on GitHub
        <ExternalLink className="size-4" />
      </a>
      <Link href={webHref} className={secondaryButtonClassName}>
        {webLabel}
        <ArrowRight className="size-4" />
      </Link>
    </>
  );
}

function ChannelToggle({
  channels,
  selected,
  onSelect,
}: {
  channels: DownloadChannels;
  selected: DownloadChannel;
  onSelect: (channel: DownloadChannel) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Release channel"
      className="inline-flex rounded-lg border border-zinc-200 p-0.5 text-xs dark:border-white/10"
    >
      {(["stable", "preview"] as const).map((channel) => {
        const manifest = channels[channel];
        const active = channel === selected;
        return (
          <button
            key={channel}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(channel)}
            className={
              active
                ? "rounded-md bg-zinc-900 px-3 py-1 font-medium text-white dark:bg-white dark:text-zinc-900"
                : "rounded-md px-3 py-1 text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            }
          >
            {channel === "stable" ? "Stable" : "Preview"}
            {manifest ? ` v${manifest.version}` : ""}
          </button>
        );
      })}
    </div>
  );
}

function HeroSection({
  channels,
  authState,
  selectedChannel,
  onSelectChannel,
  initialPlatform,
}: {
  channels: DownloadChannels;
  authState: LandingAuthState;
  selectedChannel: DownloadChannel;
  onSelectChannel: (channel: DownloadChannel) => void;
  initialPlatform: DetectedPlatform;
}) {
  const manifest = channels[selectedChannel];
  const platform = useDetectedPlatform(initialPlatform);
  const webHref = authState.isSignedIn ? "/dashboard" : "/auth/sign-in";
  const webLabel = authState.isSignedIn ? "Open Dashboard" : "Open the web app";
  const bothChannels = Boolean(channels.stable && channels.preview);

  return (
    <section className="relative overflow-hidden border-b border-zinc-200 pt-32 pb-20 dark:border-white/[0.06]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 18% 14%, rgba(24,24,27,0.06), transparent 34%), linear-gradient(rgba(24,24,27,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(24,24,27,0.035) 1px, transparent 1px)",
          backgroundSize: "100% 100%, 56px 56px, 56px 56px",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden dark:block"
        style={{
          backgroundImage:
            "radial-gradient(circle at 18% 14%, rgba(255,255,255,0.08), transparent 34%), linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "100% 100%, 56px 56px, 56px 56px",
        }}
      />

      <div className="relative mx-auto grid max-w-6xl gap-12 px-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-stretch">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-500 shadow-sm dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-400">
            <Laptop className="size-3.5" />
            {manifest
              ? manifest.channel === "stable"
                ? "Stable release"
                : "Preview build"
              : "Desktop app"}
            {manifest ? (
              <span className="text-zinc-400 dark:text-zinc-500">
                v{manifest.version}
              </span>
            ) : null}
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl font-bold tracking-tight text-zinc-950 sm:text-5xl lg:text-6xl dark:text-white">
            Download SourceWeft.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-600 sm:text-lg dark:text-zinc-400">
            Native apps for macOS and Windows today, with iOS and Android on the
            way. Every app signs in to the same account and workspaces as the
            web; local device capabilities arrive on macOS first.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <PrimaryCta
              manifest={manifest}
              platform={platform}
              webHref={webHref}
              webLabel={webLabel}
            />
          </div>

          <ul className="mt-8 grid gap-x-6 gap-y-2.5 text-sm text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
            {DESKTOP_HIGHLIGHTS.map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
                {item}
              </li>
            ))}
          </ul>

          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-zinc-200 pt-6 text-sm text-zinc-500 dark:border-white/8 dark:text-zinc-400">
            {manifest ? (
              <>
                {manifest.tag !== `v${manifest.version}` ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Tag className="size-4" />
                    {manifest.tag}
                  </span>
                ) : null}
                <a
                  href={manifest.releaseNotesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 transition-colors hover:text-zinc-900 dark:hover:text-white"
                >
                  Release notes
                  <ExternalLink className="size-3.5" />
                </a>
              </>
            ) : null}
            <Link
              href="/changelog"
              className="transition-colors hover:text-zinc-900 dark:hover:text-white"
            >
              Changelog
            </Link>
            {bothChannels ? (
              <ChannelToggle
                channels={channels}
                selected={selectedChannel}
                onSelect={onSelectChannel}
              />
            ) : null}
          </div>
        </div>

        <div className="relative lg:self-center">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-4 rounded-[2rem] bg-zinc-900/[0.05] blur-2xl dark:bg-white/[0.06]"
          />
          <div className="relative overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-900/10 lg:w-[136%] lg:max-w-none dark:border-white/10 dark:bg-zinc-900 dark:shadow-black/50">
            <Image
              src="/download/desktop-chat-light.png"
              alt="SourceWeft desktop app on macOS: a workspace with a selected reading-notes source, a drafted question in the composer, and the Hub panel listing sources"
              width={1440}
              height={900}
              // Lazy on both variants: browsers skip fetching the display:none
              // one, so each theme downloads a single hero image. The visible
              // one sits in the initial viewport and still loads immediately.
              loading="lazy"
              fetchPriority="high"
              sizes="(min-width: 1024px) 720px, 100vw"
              className="block h-auto w-full dark:hidden"
            />
            <Image
              src="/download/desktop-chat-dark.png"
              alt=""
              width={1440}
              height={900}
              loading="lazy"
              fetchPriority="high"
              sizes="(min-width: 1024px) 720px, 100vw"
              className="hidden h-auto w-full dark:block"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export function DownloadPage({
  channels,
  initialAuthState,
  initialPlatform = "unknown",
}: {
  channels: DownloadChannels;
  initialAuthState: LandingAuthState;
  initialPlatform?: DetectedPlatform;
}) {
  const authState = useLandingAuthState(initialAuthState);
  const [selectedChannel, setSelectedChannel] = useState<DownloadChannel>(
    channels.stable ? "stable" : "preview",
  );
  const manifest = channels[selectedChannel];
  const webHref = authState.isSignedIn ? "/dashboard" : "/auth/sign-in";
  const webLabel = authState.isSignedIn ? "Open Dashboard" : "Get started";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SourceWeftHeader authState={authState} />
      <main>
        <HeroSection
          channels={channels}
          authState={authState}
          selectedChannel={selectedChannel}
          onSelectChannel={setSelectedChannel}
          initialPlatform={initialPlatform}
        />
        <AllDownloadsSection manifest={manifest} />
        <MobileSection webHref={webHref} webLabel={webLabel} />
        <DesktopScreensSection />
        <EverywhereSection webHref={webHref} webLabel={webLabel} />
        <BeforeInstallSection manifest={manifest} />
        <DownloadFaqSection />
      </main>
      <SourceWeftFooter authState={authState} />
    </div>
  );
}
