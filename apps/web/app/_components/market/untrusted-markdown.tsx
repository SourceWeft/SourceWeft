"use client";

import { useMemo } from "react";
import { code } from "@streamdown/code";
import {
  defaultRehypePlugins,
  defaultUrlTransform,
  Streamdown,
  type Components,
} from "streamdown";

import { untrustedMarkdownLink } from "./untrusted-markdown-links";

// What HTML itself defines. A tag outside this list on a line of its own is an
// author's own marker (`<Good>`, `<example>`, `<EXTREMELY-IMPORTANT>`), which
// skills use heavily to structure instructions for a model.
const HTML_BLOCK_TAGS = new Set(
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param pre script search section style summary table tbody td textarea tfoot th thead title tr track ul".split(
    " ",
  ),
);

/**
 * Puts an author's own marker tags on lines of their own, as inline code.
 *
 * To a markdown parser `<Good>` alone on a line opens an HTML block that runs
 * to the next blank line, so the code fence right under it is never parsed and
 * a whole example collapses into one run of text. Raw HTML is off here anyway
 * (the tag would show as literal text), so nothing is lost by showing it as
 * `<Good>` — and the markdown around it renders the way its author meant.
 * Lines inside a code fence are left exactly as they are.
 */
export function isolateSkillMarkerTags(markdown: string) {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      out.push(line);
      continue;
    }
    const tag =
      fence === null
        ? /^\s{0,3}(<\/?([A-Za-z][A-Za-z0-9_-]*)>)\s*$/.exec(line)
        : null;
    if (tag && !HTML_BLOCK_TAGS.has(tag[2]!.toLowerCase())) {
      out.push("", `\`${tag[1]}\``, "");
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A SKILL.md is third-party text. Streamdown's default pipeline is
// raw → sanitize → harden, where `raw` (rehype-raw) is what turns embedded HTML
// into real elements. Leaving it out means HTML in the markdown never becomes
// markup: it is shown as the literal text the author typed (skills often use
// XML-like tags such as <example> in their instructions, so dropping it would
// lose content). Sanitize and harden still run over what markdown itself made.
const skillRehypePlugins = [
  defaultRehypePlugins.sanitize!,
  defaultRehypePlugins.harden!,
];

// Syntax highlighting only — no mermaid or math, which would execute
// third-party diagram/TeX source in the visitor's browser.
const plugins = { code };

// The document is embedded in a page that already has its <h1> (the skill's
// name), so its own headings sit one level down: `# Title` is an <h2> here.
// Sizes stay what a reader expects of each level in the source.
const headingClass = "mt-6 mb-2 font-semibold";
const headings: Pick<Components, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"> = {
  h1: ({ children }) => (
    <h2 className={`${headingClass} text-2xl`}>{children}</h2>
  ),
  h2: ({ children }) => (
    <h3 className={`${headingClass} text-xl`}>{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className={`${headingClass} text-lg`}>{children}</h4>
  ),
  h4: ({ children }) => (
    <h5 className={`${headingClass} text-base`}>{children}</h5>
  ),
  h5: ({ children }) => (
    <h6 className={`${headingClass} text-sm`}>{children}</h6>
  ),
  h6: ({ children }) => <p className={`${headingClass} text-sm`}>{children}</p>,
};

function untrustedMarkdownComponents(imagePlaceholder: string): Components {
  return {
    ...headings,
    a: ({ children, href }) => {
      const link = untrustedMarkdownLink(href);
      if (link.kind === "external") {
        return (
          <a
            className="font-medium underline underline-offset-4"
            href={link.href}
            rel={link.rel}
            target={link.target}
          >
            {children}
          </a>
        );
      }
      if (link.kind === "anchor") {
        return (
          <a
            className="font-medium underline underline-offset-4"
            href={link.href}
          >
            {children}
          </a>
        );
      }
      return <span>{children}</span>;
    },
    // Remote images are not loaded: they would let a third party track visitors
    // of our page and swap the picture after indexing. The alt text stays, as a
    // link to the image when it has a safe address.
    img: ({ alt, src }) => {
      const label = alt?.trim() || imagePlaceholder;
      const link = untrustedMarkdownLink(typeof src === "string" ? src : null);
      return link.kind === "external" ? (
        <a
          className="font-medium underline underline-offset-4"
          href={link.href}
          rel={link.rel}
          target={link.target}
        >
          [{label}]
        </a>
      ) : (
        <span>[{label}]</span>
      );
    },
  };
}

/**
 * How a third-party document is rendered. `skill`: a SKILL.md, whose embedded
 * HTML is never turned into markup (see {@link skillRehypePlugins}).
 */
export type UntrustedMarkdownMode = "skill";

/** Markdown someone else wrote, rendered so it cannot act on our page. */
export function UntrustedMarkdown({
  children,
  imagePlaceholder,
  mode,
}: {
  children: string;
  /** The localized word shown for an image that is not loaded, e.g. "Image". */
  imagePlaceholder: string;
  mode: UntrustedMarkdownMode;
}) {
  const components = useMemo(
    () => untrustedMarkdownComponents(imagePlaceholder),
    [imagePlaceholder],
  );
  return (
    <Streamdown
      className="w-full min-w-0 max-w-full text-sm leading-7 [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:[overflow-wrap:normal]"
      components={components}
      controls={{ code: { copy: true, download: false }, table: false }}
      linkSafety={{ enabled: false }}
      mode="static"
      parseIncompleteMarkdown={false}
      plugins={plugins}
      rehypePlugins={skillRehypePlugins}
      urlTransform={defaultUrlTransform}
    >
      {mode === "skill" ? isolateSkillMarkerTags(children) : children}
    </Streamdown>
  );
}
