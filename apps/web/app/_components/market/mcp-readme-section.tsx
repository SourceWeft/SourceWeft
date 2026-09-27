import { useTranslations } from "next-intl";

import { UntrustedMarkdown } from "./untrusted-markdown";
import {
  untrustedMarkdownLink,
  type UntrustedMarkdownBaseUrl,
} from "./untrusted-markdown-links";

/** Where an MCP server's README stands; `pending` until it is first fetched. */
export type McpReadmeStatus =
  "error" | "not_found" | "ok" | "pending" | "too_large" | "unsupported_host";

/**
 * The body of an MCP server's README section: the README itself, or why there
 * is none to read. The page owns the section's heading and layout.
 *
 * Nothing is shown while the README is `pending`, nor after a fetch `error` or
 * for a repository host we do not read (`unsupported_host`): there is nothing
 * in either a reader could act on.
 */
export function McpReadmeSection({
  markdown,
  source,
  status,
}: {
  markdown?: string | null;
  /**
   * The README's own addresses at its pinned commit. Its relative links and
   * images resolve there, and a README too large to show links to it.
   */
  source?: UntrustedMarkdownBaseUrl | null;
  status: McpReadmeStatus;
}) {
  const t = useTranslations("mcp.readme");
  if (status === "ok" && markdown) {
    return (
      <UntrustedMarkdown
        baseUrl={source ?? undefined}
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
    const link = untrustedMarkdownLink(source?.blob);
    return (
      <p className={messageClassName}>
        {t.rich("tooLarge", {
          link: (chunks) =>
            link.kind === "external" ? (
              <a
                className="font-medium text-zinc-950 underline underline-offset-4 dark:text-white"
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

const messageClassName = "text-sm leading-6 text-zinc-600 dark:text-zinc-400";
