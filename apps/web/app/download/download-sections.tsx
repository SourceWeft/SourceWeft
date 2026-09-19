"use client";

import Image from "next/image";
import Link from "next/link";
import type { ComponentType } from "react";
import {
  ArrowRight,
  Check,
  Container,
  Download,
  ExternalLink,
  Globe,
  Monitor,
  Puzzle,
  ShieldAlert,
  Smartphone,
  Terminal,
} from "lucide-react";
import { AppleIcon } from "../_components/brand-icons";

import {
  GITHUB_RELEASES_URL,
  findArtifact,
  formatArtifactSize,
  type DownloadArtifact,
  type DownloadChannelManifest,
  type DownloadPlatform,
} from "../../lib/download-channels";
import { CopyButton } from "./copy-button";
import {
  DESKTOP_SCREENS,
  DOWNLOAD_FAQ_ITEMS,
  MOBILE_PLATFORMS,
  PLATFORM_DISPLAY,
  SELF_HOST_GUIDE_URL,
  STORE_LINKS,
  type PlatformDisplay,
} from "./download-content";

export const PLATFORM_ICONS: Record<
  DownloadPlatform,
  ComponentType<{ className?: string }>
> = {
  macos: AppleIcon,
  windows: Monitor,
  linux: Terminal,
};

const primaryButtonClassName =
  "inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100";
const secondaryButtonClassName =
  "inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5";
const mutedLinkClassName =
  "inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white";

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-10 max-w-2xl">
      <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
        {eyebrow}
      </p>
      <h2 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-white">
        {title}
      </h2>
      {description ? (
        <p className="mt-3 text-zinc-500 dark:text-zinc-400">{description}</p>
      ) : null}
    </div>
  );
}

function ChecksumRow({ artifact }: { artifact: DownloadArtifact }) {
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="shrink-0">SHA-256</span>
      <code
        title={artifact.sha256}
        className="truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-300"
      >
        {artifact.sha256.slice(0, 16)}…
      </code>
      <CopyButton value={artifact.sha256} label="Copy SHA-256 checksum" />
    </div>
  );
}

function ArtifactRow({
  artifact,
  display,
}: {
  artifact: DownloadArtifact;
  display: PlatformDisplay;
}) {
  return (
    <div className="rounded-xl border border-zinc-100 bg-zinc-50 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-950 dark:text-white">
            {display.archLabels[artifact.arch]}
          </p>
          <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
            {artifact.filename}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {display.fileType} · {formatArtifactSize(artifact.size)}
          </p>
        </div>
        <a
          href={artifact.url}
          download={artifact.filename}
          rel="noopener"
          className={primaryButtonClassName}
        >
          <Download className="size-4" />
          Download
        </a>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <ChecksumRow artifact={artifact} />
        <a
          href={artifact.githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={mutedLinkClassName}
        >
          GitHub mirror
          <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  );
}

function PlatformCard({
  display,
  manifest,
}: {
  display: PlatformDisplay;
  manifest: DownloadChannelManifest;
}) {
  const Icon = PLATFORM_ICONS[display.id];
  const artifacts = display.archOrder.map((arch) => ({
    arch,
    artifact: findArtifact(manifest, display.id, arch),
  }));
  const hasAny = artifacts.some((entry) => entry.artifact);

  return (
    <article
      id={`download-${display.id}`}
      className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900/50"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-200">
          <Icon className="size-5" />
        </span>
        <div>
          <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
            {display.label}
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {display.requirement}
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-1 flex-col gap-3">
        {hasAny ? (
          artifacts.map(({ arch, artifact }) =>
            artifact ? (
              <ArtifactRow key={arch} artifact={artifact} display={display} />
            ) : (
              <div
                key={arch}
                className="flex items-center justify-between rounded-xl border border-dashed border-zinc-200 px-4 py-3 text-sm text-zinc-400 dark:border-white/10 dark:text-zinc-500"
              >
                <span>{display.archLabels[arch]}</span>
                <span className="text-xs">Not available yet</span>
              </div>
            ),
          )
        ) : (
          <div className="flex flex-1 flex-col justify-between rounded-xl border border-dashed border-zinc-200 p-4 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <p>
              {display.label} builds are not published yet. Use the web app in
              your browser, or watch this page for the first release.
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

export function AllDownloadsSection({
  manifest,
}: {
  manifest: DownloadChannelManifest | null;
}) {
  return (
    <section id="all-downloads" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          eyebrow="All downloads"
          title="Every build, with its checksum."
          description={
            manifest
              ? `Version ${manifest.version} from the ${manifest.channel} channel. Compare the SHA-256 before installing an unsigned build.`
              : "Desktop installers are published with every tagged release."
          }
        />
        {manifest ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {PLATFORM_DISPLAY.map((display) => (
              <PlatformCard
                key={display.id}
                display={display}
                manifest={manifest}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900/50">
            <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              The download channel has not been promoted yet. macOS and Windows
              installers for the latest tagged release are available from GitHub
              Releases, together with the self-hosting archive.
            </p>
            <a
              href={GITHUB_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-5 ${primaryButtonClassName}`}
            >
              View releases on GitHub
              <ExternalLink className="size-4" />
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

type EntryAction =
  | { label: string; href: string; external?: boolean }
  | { label: string; comingSoon: true };

function EntryCard({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  actions: EntryAction[];
}) {
  return (
    <article className="flex flex-col rounded-2xl border border-zinc-200 bg-zinc-50 p-6 dark:border-white/[0.08] dark:bg-zinc-900/40">
      <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-200">
        <Icon className="size-5" />
      </div>
      <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
        {title}
      </h3>
      <p className="mt-3 flex-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {description}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {actions.map((action) =>
          "comingSoon" in action ? (
            <span
              key={action.label}
              className="inline-flex items-center rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 dark:border-white/15 dark:text-zinc-400"
            >
              {action.label} · Coming soon
            </span>
          ) : action.external ? (
            <a
              key={action.label}
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              className={secondaryButtonClassName}
            >
              {action.label}
              <ExternalLink className="size-3.5" />
            </a>
          ) : (
            <Link
              key={action.label}
              href={action.href}
              className={secondaryButtonClassName}
            >
              {action.label}
              <ArrowRight className="size-3.5" />
            </Link>
          ),
        )}
      </div>
    </article>
  );
}

function storeAction(label: string, href: string | undefined): EntryAction {
  return href ? { label, href, external: true } : { label, comingSoon: true };
}

export function MobileSection({
  webHref,
  webLabel,
}: {
  webHref: string;
  webLabel: string;
}) {
  const anyStoreLive = MOBILE_PLATFORMS.some((entry) => STORE_LINKS[entry.id]);
  return (
    <section
      id="mobile"
      className="scroll-mt-20 border-t border-zinc-200 py-20 dark:border-white/[0.06]"
    >
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          eyebrow="Mobile apps"
          title="SourceWeft in your pocket."
          description={
            anyStoreLive
              ? "Read, ask, and review your sources on the go. Signed in to the same workspaces as desktop and web."
              : "Read, ask, and review your sources on the go. The iOS and Android apps are in preparation; until the store listings go live, the web app works in Safari and Chrome on any phone."
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          {MOBILE_PLATFORMS.map((entry) => {
            const href = STORE_LINKS[entry.id];
            const Icon = entry.id === "ios" ? AppleIcon : Smartphone;
            return (
              <article
                key={entry.id}
                className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900/50"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-200">
                    <Icon className="size-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
                      {entry.label}
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {entry.devices} · {entry.store}
                    </p>
                  </div>
                </div>
                <div className="mt-5 flex flex-1 flex-col justify-end gap-3">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={primaryButtonClassName}
                    >
                      <Download className="size-4" />
                      {entry.storeAction}
                    </a>
                  ) : (
                    <>
                      <div className="flex items-center justify-between rounded-xl border border-dashed border-zinc-200 px-4 py-3 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                        <span>{entry.store}</span>
                        <span className="text-xs">Coming soon</span>
                      </div>
                      <Link
                        href={webHref}
                        className={`${secondaryButtonClassName} justify-center`}
                      >
                        {webLabel} on {entry.label}
                        <ArrowRight className="size-3.5" />
                      </Link>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function EverywhereSection({
  webHref,
  webLabel,
}: {
  webHref: string;
  webLabel: string;
}) {
  return (
    <section className="border-t border-zinc-200 py-20 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          eyebrow="Everywhere you work"
          title="Same notebook, every surface."
          description="Desktop and mobile are two entry points. Your workspaces stay in sync with the web app, the browser extension, and your own self-hosted instance."
        />
        <div className="grid gap-4 md:grid-cols-3">
          <EntryCard
            icon={Globe}
            title="Web app"
            description="No install required. Open SourceWeft in any modern browser and pick up where you left off."
            actions={[{ label: webLabel, href: webHref }]}
          />
          <EntryCard
            icon={Puzzle}
            title="Browser extension"
            description="Capture pages and clips into your notebook straight from Chrome or Edge."
            actions={[
              storeAction("Chrome", STORE_LINKS.chrome),
              storeAction("Edge", STORE_LINKS.edge),
            ]}
          />
          <EntryCard
            icon={Container}
            title="Self-host"
            description="Run SourceWeft on your own infrastructure with the Docker Compose bundle shipped with every release."
            actions={[
              {
                label: "Docker guide",
                href: SELF_HOST_GUIDE_URL,
                external: true,
              },
              { label: "Releases", href: GITHUB_RELEASES_URL, external: true },
            ]}
          />
        </div>
      </div>
    </section>
  );
}

export function BeforeInstallSection({
  manifest,
}: {
  manifest: DownloadChannelManifest | null;
}) {
  const artifacts = manifest?.artifacts ?? [];
  const unsigned =
    artifacts.length === 0 ||
    artifacts.some((entry) => !entry.distributionSigned || !entry.notarized);
  const localExecutionPlatforms = PLATFORM_DISPLAY.filter((display) =>
    artifacts.some(
      (entry) => entry.platform === display.id && entry.localExecutionSupported,
    ),
  ).map((display) => display.label);

  return (
    <section className="border-t border-zinc-200 py-20 dark:border-white/[0.06]">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            Before you install
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-white">
            System requirements
          </h2>
          <ul className="mt-7 space-y-3">
            {PLATFORM_DISPLAY.filter((display) => display.id !== "linux").map(
              (display) => (
                <li
                  key={display.id}
                  className="flex gap-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400"
                >
                  <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
                  <span>
                    <span className="font-medium text-zinc-900 dark:text-white">
                      {display.label}
                    </span>{" "}
                    · {display.requirement}
                  </span>
                </li>
              ),
            )}
            <li className="flex gap-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
              <span>
                <span className="font-medium text-zinc-900 dark:text-white">
                  Account
                </span>{" "}
                · the desktop app signs in with your existing SourceWeft account
              </span>
            </li>
            <li className="flex gap-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
              <span>
                <span className="font-medium text-zinc-900 dark:text-white">
                  Local device execution
                </span>{" "}
                ·{" "}
                {localExecutionPlatforms.length > 0
                  ? `${localExecutionPlatforms.join(" and ")} only for now`
                  : "macOS first; Windows support is in progress"}
              </span>
            </li>
          </ul>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/[0.08] dark:bg-zinc-900/50">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            <ShieldAlert className="size-4 text-amber-500" />
            {unsigned ? "Unsigned builds" : "Verifying your download"}
          </div>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            {unsigned
              ? "Current installers are not code-signed yet."
              : "Check the checksum before you install."}
          </h3>
          <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            {unsigned
              ? "Your operating system will warn about an unidentified developer. Verify the SHA-256 on this page, then allow the app once."
              : "Every installer on this page lists its SHA-256 so you can confirm the file you downloaded is the one we published."}
          </p>
          {unsigned ? (
            <ul className="mt-5 space-y-4">
              <li className="border-l border-zinc-200 pl-4 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:text-zinc-400">
                <span className="font-medium text-zinc-900 dark:text-white">
                  macOS
                </span>
                : Control-click SourceWeft in Applications, choose Open, then
                confirm in the dialog.
              </li>
              <li className="border-l border-zinc-200 pl-4 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:text-zinc-400">
                <span className="font-medium text-zinc-900 dark:text-white">
                  Windows
                </span>
                : when SmartScreen appears, choose More info, then Run anyway.
              </li>
            </ul>
          ) : null}
          <p className="mt-5 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            Verify the checksum
          </p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-6 text-zinc-200 dark:bg-black/40">
            {
              "# macOS\nshasum -a 256 ~/Downloads/SourceWeft_*.dmg\n\n# Windows (PowerShell)\nGet-FileHash .\\SourceWeft_*-setup.exe -Algorithm SHA256"
            }
          </pre>
        </div>
      </div>
    </section>
  );
}

export function DesktopScreensSection() {
  return (
    <section className="border-t border-zinc-200 py-20 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          eyebrow="A closer look"
          title="What you get on the desktop."
          description="Captured from the macOS app. The same workspaces as the web, plus the parts that only make sense next to your files and your machine."
        />
        <div className="grid gap-6 md:grid-cols-2">
          {DESKTOP_SCREENS.map((screen) => (
            <figure
              key={screen.id}
              className="overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 dark:border-white/[0.08] dark:bg-zinc-900/40"
            >
              <div className="border-b border-zinc-200 bg-white dark:border-white/[0.08] dark:bg-zinc-900">
                <Image
                  src={`/download/desktop-${screen.id}-light.png`}
                  alt={screen.title}
                  width={1440}
                  height={900}
                  sizes="(min-width: 768px) 560px, 100vw"
                  className="block h-auto w-full dark:hidden"
                />
                <Image
                  src={`/download/desktop-${screen.id}-dark.png`}
                  alt=""
                  width={1440}
                  height={900}
                  sizes="(min-width: 768px) 560px, 100vw"
                  className="hidden h-auto w-full dark:block"
                />
              </div>
              <figcaption className="p-5">
                <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
                  {screen.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                  {screen.caption}
                </p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

export function DownloadFaqSection() {
  return (
    <section className="border-t border-zinc-200 py-20 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading eyebrow="FAQ" title="Download and install basics" />
        <div className="grid gap-4 md:grid-cols-2">
          {DOWNLOAD_FAQ_ITEMS.map((item) => (
            <article
              key={item.question}
              className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-white/[0.08] dark:bg-zinc-900/50"
            >
              <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
                {item.question}
              </h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {item.answer}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
