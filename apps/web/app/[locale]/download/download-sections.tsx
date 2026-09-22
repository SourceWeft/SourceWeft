"use client";

import Image from "next/image";
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
import { useTranslations } from "next-intl";
import { AppleIcon } from "../../_components/brand-icons";

import { LocaleLink } from "../_components/locale-link";
import {
  GITHUB_RELEASES_URL,
  findArtifact,
  formatArtifactSize,
  type DownloadArtifact,
  type DownloadChannelManifest,
  type DownloadPlatform,
} from "../../../lib/download-channels";
import { CopyButton } from "./copy-button";
import {
  DESKTOP_SCREENS,
  DOWNLOAD_FAQ_KEYS,
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
  const t = useTranslations("download.allDownloads");
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="shrink-0">SHA-256</span>
      <code
        title={artifact.sha256}
        className="truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-300"
      >
        {artifact.sha256.slice(0, 16)}…
      </code>
      <CopyButton value={artifact.sha256} label={t("copyChecksum")} />
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
  const t = useTranslations("download.allDownloads");
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
          {t("download")}
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
          {t("githubMirror")}
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
  const t = useTranslations("download");
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
            {t(`platforms.${display.id}.requirement`)}
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
                <span className="text-xs">{t("allDownloads.notAvailable")}</span>
              </div>
            ),
          )
        ) : (
          <div className="flex flex-1 flex-col justify-between rounded-xl border border-dashed border-zinc-200 p-4 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <p>{t("allDownloads.platformUnavailable", { platform: display.label })}</p>
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
  const t = useTranslations("download");
  return (
    <section id="all-downloads" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          eyebrow={t("allDownloads.eyebrow")}
          title={t("allDownloads.title")}
          description={
            manifest
              ? t("allDownloads.descriptionWithVersion", {
                  version: manifest.version,
                  channel: manifest.channel,
                })
              : t("allDownloads.descriptionFallback")
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
              {t("allDownloads.channelNotPromoted")}
            </p>
            <a
              href={GITHUB_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-5 ${primaryButtonClassName}`}
            >
              {t("cta.viewReleasesGithub")}
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
  const t = useTranslations("download.everywhere");
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
              {t("comingSoonLabel", { name: action.label })}
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
            <LocaleLink
              key={action.label}
              href={action.href}
              className={secondaryButtonClassName}
            >
              {action.label}
              <ArrowRight className="size-3.5" />
            </LocaleLink>
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
  const t = useTranslations("download");
  const anyStoreLive = MOBILE_PLATFORMS.some((entry) => STORE_LINKS[entry.id]);
  return (
    <section
      id="mobile"
      className="scroll-mt-20 border-t border-zinc-200 py-20 dark:border-white/[0.06]"
    >
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          eyebrow={t("mobile.eyebrow")}
          title={t("mobile.title")}
          description={
            anyStoreLive
              ? t("mobile.descriptionLive")
              : t("mobile.descriptionComingSoon")
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
                      {t(`mobile.${entry.id}.devices`)} · {entry.store}
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
                      {t(`mobile.${entry.id}.storeAction`)}
                    </a>
                  ) : (
                    <>
                      <div className="flex items-center justify-between rounded-xl border border-dashed border-zinc-200 px-4 py-3 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                        <span>{entry.store}</span>
                        <span className="text-xs">{t("comingSoon")}</span>
                      </div>
                      <LocaleLink
                        href={webHref}
                        className={`${secondaryButtonClassName} justify-center`}
                      >
                        {t("mobile.openWebOn", {
                          webLabel,
                          platform: entry.label,
                        })}
                        <ArrowRight className="size-3.5" />
                      </LocaleLink>
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
  const t = useTranslations("download.everywhere");
  return (
    <section className="border-t border-zinc-200 py-20 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("description")}
        />
        <div className="grid gap-4 md:grid-cols-3">
          <EntryCard
            icon={Globe}
            title={t("webApp.title")}
            description={t("webApp.description")}
            actions={[{ label: webLabel, href: webHref }]}
          />
          <EntryCard
            icon={Puzzle}
            title={t("browserExtension.title")}
            description={t("browserExtension.description")}
            actions={[
              storeAction("Chrome", STORE_LINKS.chrome),
              storeAction("Edge", STORE_LINKS.edge),
            ]}
          />
          <EntryCard
            icon={Container}
            title={t("selfHost.title")}
            description={t("selfHost.description")}
            actions={[
              {
                label: t("selfHost.dockerGuide"),
                href: SELF_HOST_GUIDE_URL,
                external: true,
              },
              { label: t("selfHost.releases"), href: GITHUB_RELEASES_URL, external: true },
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
  const t = useTranslations("download");
  const artifacts = manifest?.artifacts ?? [];
  const unsigned =
    artifacts.length === 0 ||
    artifacts.some(
      (entry) =>
        entry.platform !== "linux" &&
        (!entry.distributionSigned ||
          (entry.platform === "macos" && !entry.notarized)),
    );
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
            {t("beforeInstall.eyebrow")}
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-white">
            {t("beforeInstall.title")}
          </h2>
          <ul className="mt-7 space-y-3">
            {PLATFORM_DISPLAY.map((display) => (
              <li
                key={display.id}
                className="flex gap-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400"
              >
                <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
                <span>
                  <span className="font-medium text-zinc-900 dark:text-white">
                    {display.label}
                  </span>{" "}
                  · {t(`platforms.${display.id}.requirement`)}
                </span>
              </li>
            ))}
            <li className="flex gap-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
              <span>
                <span className="font-medium text-zinc-900 dark:text-white">
                  {t("beforeInstall.account")}
                </span>{" "}
                · {t("beforeInstall.accountDescription")}
              </span>
            </li>
            <li className="flex gap-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
              <span>
                <span className="font-medium text-zinc-900 dark:text-white">
                  {t("beforeInstall.localExecution")}
                </span>{" "}
                ·{" "}
                {localExecutionPlatforms.length > 0
                  ? t("beforeInstall.localExecutionAvailable", {
                      platforms: localExecutionPlatforms.join(
                        t("beforeInstall.listJoiner"),
                      ),
                    })
                  : t("beforeInstall.localExecutionFallback")}
              </span>
            </li>
          </ul>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/[0.08] dark:bg-zinc-900/50">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            <ShieldAlert className="size-4 text-amber-500" />
            {unsigned
              ? t("beforeInstall.unsignedEyebrow")
              : t("beforeInstall.verifyingEyebrow")}
          </div>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            {unsigned
              ? t("beforeInstall.unsignedTitle")
              : t("beforeInstall.verifyingTitle")}
          </h3>
          <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            {unsigned
              ? t("beforeInstall.unsignedBody")
              : t("beforeInstall.verifyingBody")}
          </p>
          {unsigned ? (
            <ul className="mt-5 space-y-4">
              <li className="border-l border-zinc-200 pl-4 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:text-zinc-400">
                <span className="font-medium text-zinc-900 dark:text-white">
                  macOS
                </span>
                {t("beforeInstall.macosInstruction")}
              </li>
              <li className="border-l border-zinc-200 pl-4 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:text-zinc-400">
                <span className="font-medium text-zinc-900 dark:text-white">
                  Windows
                </span>
                {t("beforeInstall.windowsInstruction")}
              </li>
            </ul>
          ) : null}
          <p className="mt-5 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            {t("beforeInstall.verifyChecksum")}
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
  const t = useTranslations("download.screens");
  return (
    <section className="border-t border-zinc-200 py-20 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("description")}
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
                  alt={t(`items.${screen.id}.title`)}
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
                  {t(`items.${screen.id}.title`)}
                </h3>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                  {t(`items.${screen.id}.caption`)}
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
  const t = useTranslations("download.faq");
  return (
    <section className="border-t border-zinc-200 py-20 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading eyebrow={t("eyebrow")} title={t("title")} />
        <div className="grid gap-4 md:grid-cols-2">
          {DOWNLOAD_FAQ_KEYS.map((key) => (
            <article
              key={key}
              className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-white/[0.08] dark:bg-zinc-900/50"
            >
              <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
                {t(`items.${key}.question`)}
              </h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {t(`items.${key}.answer`)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
