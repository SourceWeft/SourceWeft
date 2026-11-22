import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { PublicSharedChat } from "@sourceweft/contracts";
import { SharedChatMarkdown } from "./shared-chat-markdown";

/**
 * Same shape as the share dialog's `SNAPSHOT_DATE_OPTIONS`
 * (apps/web/app/dashboard/_components/share-chat-dialog.tsx) — duplicated
 * rather than imported because that module is a client dialog with its own
 * dependency surface, and this is the only other place the "as of" format is
 * needed. Exported so the test can compute the exact expected string.
 *
 * No `Intl.DateTimeFormatOptions` annotation: that type's `timeZoneName`
 * admits newer values (`"shortOffset"`, …) that `next-intl`'s own
 * `DateTimeFormatOptions` doesn't yet, so annotating it that way makes this
 * object fail to type-check as an argument to `formatter.dateTime` even
 * though it never sets `timeZoneName` at all. `as const` keeps the literal
 * values precise without that wider, incompatible shape.
 */
export const AS_OF_DATE_OPTIONS = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
} as const;

type SharedMessage = PublicSharedChat["messages"][number];

/**
 * Every artifact kind the backend can currently send (`artifactTypeSchema` in
 * `@sourceweft/contracts`). Kept as a local list — rather than importing that
 * schema — so a future kind the backend adds before this page knows about it
 * degrades to a title-cased identifier instead of a crash or an `undefined`
 * catalog lookup.
 */
const KNOWN_ARTIFACT_KINDS = [
  "file",
  "html",
  "report",
  "slides",
  "mindmap",
  "podcast",
  "audio_overview",
  "video_overview",
  "video_presentation",
  "flashcards",
  "quiz",
  "table",
  "infographic",
  "image",
] as const;
type KnownArtifactKind = (typeof KNOWN_ARTIFACT_KINDS)[number];

function isKnownArtifactKind(kind: string): kind is KnownArtifactKind {
  return (KNOWN_ARTIFACT_KINDS as readonly string[]).includes(kind);
}

/**
 * The visitor-locale label for an artifact kind, from
 * `sharedChat.artifactKinds.*`. A kind this page doesn't know about yet (the
 * backend added one more recently than this catalog) falls back to its
 * identifier, title-cased — always English, since there is no catalog entry
 * to translate.
 */
function artifactKindLabel(
  kind: string,
  translate: (key: `artifactKinds.${KnownArtifactKind}`) => string,
) {
  if (isKnownArtifactKind(kind)) {
    return translate(`artifactKinds.${kind}`);
  }
  return kind
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function SharedChatFootnotes({
  citations,
  sourcesLabel,
}: {
  citations: SharedMessage["citations"];
  sourcesLabel: string;
}) {
  if (citations.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      <p className="font-medium">{sourcesLabel}</p>
      <ol className="mt-1 list-none space-y-0.5">
        {citations.map((citation) => (
          <li key={citation.n}>
            {citation.url ? (
              <a
                href={citation.url}
                rel="nofollow noopener noreferrer"
                target="_blank"
              >
                {citation.n}. {citation.title}
              </a>
            ) : (
              <span>
                {citation.n}. {citation.title}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SharedChatArtifactCards({
  artifacts,
  kindLabel,
}: {
  artifacts: SharedMessage["artifacts"];
  kindLabel: (kind: string) => string;
}) {
  if (artifacts.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {artifacts.map((artifact, index) => {
        const label = `${kindLabel(artifact.kind)} · ${artifact.title}`;
        return artifact.publicUrl ? (
          <a
            className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            href={artifact.publicUrl}
            key={index}
            rel="noopener"
          >
            {label}
          </a>
        ) : (
          <span
            className="rounded-md border px-2 py-1 text-xs text-muted-foreground"
            key={index}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

/** Images after the text, skipping any URL the content already rendered inline. */
function SharedChatMessageImages({
  content,
  images,
}: {
  content: string;
  images: SharedMessage["images"];
}) {
  const extra = images.filter((image) => !content.includes(image.url));
  if (extra.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {extra.map((image, index) => (
        // eslint-disable-next-line @next/next/no-img-element -- a signed, token-scoped public URL; next/image's remote-pattern allowlist is not worth wiring for an anonymous share page.
        <img
          alt={image.name}
          className="max-h-64 rounded-md border object-contain"
          key={index}
          src={image.url}
        />
      ))}
    </div>
  );
}

function SharedChatMessage({
  allowedImageUrls,
  assistantLabel,
  kindLabel,
  labels,
  message,
}: {
  allowedImageUrls: string[];
  assistantLabel: string;
  kindLabel: (kind: string) => string;
  labels: { stopped: string; sources: string; user: string };
  message: SharedMessage;
}) {
  const roleLabel = message.role === "user" ? labels.user : assistantLabel;

  return (
    <article className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {roleLabel}
      </span>
      <SharedChatMarkdown
        allowedImageUrls={allowedImageUrls}
        content={message.content}
      />
      {message.stopped ? (
        <p className="text-xs italic text-muted-foreground">{labels.stopped}</p>
      ) : null}
      <SharedChatMessageImages
        content={message.content}
        images={message.images}
      />
      <SharedChatArtifactCards
        artifacts={message.artifacts}
        kindLabel={kindLabel}
      />
      <SharedChatFootnotes
        citations={message.citations}
        sourcesLabel={labels.sources}
      />
    </article>
  );
}

/**
 * Server component: no client-side re-formatting of `takenAt` means the
 * server's rendered text is the only text, so there is nothing for React to
 * hydration-mismatch against a visitor's browser timezone. `MessageResponse`
 * (via `SharedChatMarkdown`) is its own `"use client"` component further down the tree, which is fine —
 * a server component can render a client one.
 */
export async function SharedChatView({ chat }: { chat: PublicSharedChat }) {
  const t = await getTranslations("sharedChat");
  const format = await getFormatter();
  const assistantLabel = chat.assistantName ?? t("assistant");
  const labels = {
    sources: t("sources"),
    stopped: t("stopped"),
    user: t("user"),
  };
  const kindLabel = (kind: string) => artifactKindLabel(kind, t);
  // The only images message Markdown may show: this share's own
  // token-scoped image URLs, never another host.
  const allowedImageUrls = [
    ...new Set(
      chat.messages.flatMap((message) =>
        message.images.map((image) => image.url),
      ),
    ),
  ];

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1 border-b pb-4">
        <h1 className="text-lg font-semibold">{chat.title}</h1>
        <p className="text-xs text-muted-foreground">
          {t("sharedOnAsOf", {
            date: format.dateTime(new Date(chat.takenAt), AS_OF_DATE_OPTIONS),
          })}
        </p>
      </header>

      <div className="flex flex-1 flex-col gap-6">
        {chat.messages.map((message, index) => (
          <SharedChatMessage
            allowedImageUrls={allowedImageUrls}
            assistantLabel={assistantLabel}
            kindLabel={kindLabel}
            key={index}
            labels={labels}
            message={message}
          />
        ))}
      </div>

      <footer className="border-t pt-4 text-center">
        <Link
          className="text-xs text-muted-foreground hover:text-foreground"
          href="/"
          rel="noopener"
        >
          {t("madeWith")}
        </Link>
      </footer>
    </main>
  );
}

export async function SharedChatUnavailable() {
  const t = await getTranslations("sharedChat");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
    </main>
  );
}
