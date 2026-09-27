import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  mcpReadmeBaseUrl,
  mcpReadmeFallbackLink,
  type McpReadmePayload,
  type McpReadmeSource,
  type McpReadmeStatus,
} from "../../../lib/mcp-readme";
import { UntrustedMarkdown } from "./untrusted-markdown";
import { untrustedMarkdownLink } from "./untrusted-markdown-links";

export type { McpReadmeStatus };

/**
 * The body of an MCP server's README section: the README itself, or why there
 * is none to read. The page owns the section's heading and layout. It takes a
 * detail response's `readme` as it is (`<McpReadmeSection {...readme} />`).
 *
 * Nothing is shown while the README is `pending`, nor after a fetch `error` or
 * for a repository host we do not read (`unsupported_host`): there is nothing
 * in either a reader could act on here (see {@link McpReadmeRepositoryLink}).
 */
export function McpReadmeSection({
  markdown,
  source,
  status,
}: {
  markdown?: string | null;
  /**
   * The README's own addresses at its pinned commit. Its relative links and
   * images resolve there (when both are known), and a README too large to
   * show links to its page.
   */
  source?: Pick<McpReadmeSource, "blobUrl" | "rawUrl"> | null;
  status: McpReadmeStatus;
}) {
  const t = useTranslations("mcp.readme");
  if (status === "ok" && markdown) {
    return (
      <UntrustedMarkdown
        baseUrl={mcpReadmeBaseUrl(source)}
        imagePlaceholder={t("imagePlaceholder")}
        mode="readme"
      >
        {markdown}
      </UntrustedMarkdown>
    );
  }
  if (status === "not_found") {
    return <p className={messageClassName}>{t("notFound")}</p>;
  }
  if (status === "too_large") {
    const link = untrustedMarkdownLink(source?.blobUrl);
    return (
      <p className={messageClassName}>
        {t.rich("tooLarge", {
          link: (chunks) =>
            link.kind === "external" ? (
              <a
                className={linkClassName}
                href={link.href}
                rel={link.rel}
                target={link.target}
              >
                {chunks}
              </a>
            ) : (
              chunks
            ),
        })}
      </p>
    );
  }
  return null;
}

const COMMIT_SHA = /^[0-9a-f]{40,}$/i;

/**
 * Where the README shown was read from: its path, linked to the file at the
 * pinned commit, and that commit. Only under a README that is shown (`ok`).
 */
export function McpReadmeSourceLine({
  readme,
}: {
  readme: McpReadmePayload | null;
}) {
  const t = useTranslations("mcp.readme");
  const source = readme?.source;
  if (readme?.status !== "ok" || !readme.markdown || !source) return null;
  const link = untrustedMarkdownLink(source.blobUrl);
  if (!source.path && link.kind !== "external") return null;
  const path = source.path ?? "README";
  const commit = source.ref
    ? COMMIT_SHA.test(source.ref)
      ? source.ref.slice(0, 7)
      : source.ref
    : null;
  const values = {
    code: (chunks: ReactNode) => <code className="font-mono">{chunks}</code>,
    link: (chunks: ReactNode) =>
      link.kind === "external" ? (
        <a
          className={linkClassName}
          href={link.href}
          rel={link.rel}
          target={link.target}
        >
          {chunks}
        </a>
      ) : (
        <span className="font-medium text-zinc-950 dark:text-white">
          {chunks}
        </span>
      ),
  };
  return (
    <p className="break-all text-xs leading-5 text-zinc-500 dark:text-zinc-400">
      {commit
        ? t.rich("sourceAtCommit", { ...values, commit, path })
        : t.rich("source", { link: values.link, path })}
    </p>
  );
}

/**
 * Where to read the README when it could not be read here (a fetch `error`,
 * or a repository host we do not read): the repository itself. Nothing for
 * any other status, or when the repository has no safe address.
 */
export function McpReadmeRepositoryLink({
  readme,
}: {
  readme: McpReadmePayload | null;
}) {
  const t = useTranslations("mcp.readme");
  const link = mcpReadmeFallbackLink(readme);
  if (!link) return null;
  return (
    <a
      className={`inline-flex items-center gap-1.5 text-sm ${linkClassName}`}
      href={link.href}
      rel={link.rel}
      target={link.target}
    >
      {t("viewInRepository")}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}

const messageClassName = "text-sm leading-6 text-zinc-600 dark:text-zinc-400";
const linkClassName =
  "font-medium text-zinc-950 underline underline-offset-4 dark:text-white";
