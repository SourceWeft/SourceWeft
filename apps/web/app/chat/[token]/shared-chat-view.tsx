"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { PublicSharedChat } from "@sourceweft/contracts";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { formatDisplayDate } from "../../../lib/i18n/format";

/**
 * Same shape as the share dialog's `SNAPSHOT_DATE_OPTIONS`
 * (apps/web/app/dashboard/_components/share-chat-dialog.tsx) — duplicated
 * rather than imported because that module is a client dialog with its own
 * dependency surface, and this is the only other place the "as of" format is
 * needed. Exported so the test can compute the exact expected string.
 */
export const AS_OF_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
};

type SharedMessage = PublicSharedChat["messages"][number];

/**
 * The backend sends the artifact's raw type id (e.g. "video_presentation"),
 * never localized — titlecase it rather than pulling in the dashboard's
 * `artifactTypeLabel`/i18n catalog, which this anonymous, no-session page has
 * no reason to depend on.
 */
function artifactKindLabel(kind: string) {
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
              // The spec'd rel is exactly "nofollow noopener" (no
              // "noreferrer"): noopener alone already blocks window.opener
              // access, and the citation target itself — not a referrer
              // leak — is the thing being disclosed here.
              // eslint-disable-next-line react/jsx-no-target-blank
              <a href={citation.url} rel="nofollow noopener" target="_blank">
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
}: {
  artifacts: SharedMessage["artifacts"];
}) {
  if (artifacts.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {artifacts.map((artifact, index) => {
        const label = `${artifactKindLabel(artifact.kind)} · ${artifact.title}`;
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
  assistantLabel,
  message,
}: {
  assistantLabel: string;
  message: SharedMessage;
}) {
  const t = useTranslations("sharedChat");
  const roleLabel = message.role === "user" ? t("user") : assistantLabel;

  return (
    <article className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {roleLabel}
      </span>
      <MessageResponse>{message.content}</MessageResponse>
      {message.stopped ? (
        <p className="text-xs italic text-muted-foreground">{t("stopped")}</p>
      ) : null}
      <SharedChatMessageImages
        content={message.content}
        images={message.images}
      />
      <SharedChatArtifactCards artifacts={message.artifacts} />
      <SharedChatFootnotes
        citations={message.citations}
        sourcesLabel={t("sources")}
      />
    </article>
  );
}

export function SharedChatView({ chat }: { chat: PublicSharedChat }) {
  const t = useTranslations("sharedChat");
  const locale = useLocale();
  const assistantLabel = chat.assistantName ?? t("assistant");

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1 border-b pb-4">
        <h1 className="text-lg font-semibold">{chat.title}</h1>
        <p className="text-xs text-muted-foreground">
          {t("sharedOnAsOf", {
            date: formatDisplayDate(
              new Date(chat.takenAt),
              locale,
              AS_OF_DATE_OPTIONS,
            ),
          })}
        </p>
      </header>

      <div className="flex flex-1 flex-col gap-6">
        {chat.messages.map((message, index) => (
          <SharedChatMessage
            assistantLabel={assistantLabel}
            key={index}
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

export function SharedChatUnavailable() {
  const t = useTranslations("sharedChat");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
    </main>
  );
}
