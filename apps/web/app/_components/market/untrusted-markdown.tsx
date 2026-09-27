"use client";

import { useMemo, type ComponentProps, type ComponentType } from "react";
import { code } from "@streamdown/code";
import {
  defaultRehypePlugins,
  defaultUrlTransform,
  Streamdown,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from "streamdown";

import {
  untrustedMarkdownLink,
  type UntrustedMarkdownBaseUrl,
} from "./untrusted-markdown-links";

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

type Pluggable = NonNullable<StreamdownProps["rehypePlugins"]>[number];
type HastElement = NonNullable<ExtraProps["node"]>;
type HastChild = HastElement["children"][number];

/** One of Streamdown's `[plugin, options]` defaults, run with other options. */
function withOptions(name: "harden" | "sanitize", options: object): Pluggable {
  const pluggable = defaultRehypePlugins[name];
  if (!Array.isArray(pluggable)) {
    throw new Error(`Streamdown's ${name} plugin is not a [plugin, options]`);
  }
  return [pluggable[0], options];
}

const aria = ["ariaDescribedBy", "ariaLabel", "ariaLabelledBy"];

// The HTML a README may keep. READMEs are written for GitHub, which renders the
// HTML in them through its own allow-list; this is that list as
// hast-util-sanitize ships it (`defaultSchema`, which Streamdown uses), made
// stricter, and spelled out so a dependency update cannot widen it:
// - no <picture>/<source>, `srcSet` or `longDesc`: nothing that names a picture
//   for the browser to fetch (<img> itself is replaced before render);
// - only presentational attributes (`align`, `width`, `open`, …): no form,
//   focus or keyboard attributes (`action`, `tabIndex`, `accessKey`, …);
// - an address with a scheme is http(s) or mailto for a link and http(s) for
//   an image (relative ones are settled next, by settleReadmeLinks);
// - <script>, <style>, frames, forms, embedded SVG and similar go with
//   everything inside them instead of leaving their source behind as text.
// Anything else (event handlers, `style`, `class`, unknown tags) is dropped;
// an unknown tag keeps its content. `input` stays only as GFM task lists make
// it: a disabled checkbox.
const readmeSanitizeSchema = {
  ancestors: {
    tbody: ["table"],
    td: ["table"],
    tfoot: ["table"],
    th: ["table"],
    thead: ["table"],
    tr: ["table"],
  },
  attributes: {
    a: [
      ...aria,
      "dataFootnoteBackref",
      "dataFootnoteRef",
      ["className", "data-footnote-backref"],
      "href",
    ],
    // `metastring` is the code fence's info string (Streamdown's code blocks).
    code: [["className", /^language-./], "metastring"],
    dl: aria,
    h2: [["className", "sr-only"]],
    img: ["src"],
    input: ["checked", ["disabled", true], ["type", "checkbox"]],
    li: [["className", "task-list-item"]],
    ol: [...aria, ["className", "contains-task-list"]],
    section: ["dataFootnotes", ["className", "footnotes"]],
    summary: aria,
    table: aria,
    ul: [...aria, ["className", "contains-task-list"]],
    "*": [
      "abbr",
      "align",
      "alt",
      "border",
      "cellPadding",
      "cellSpacing",
      "clear",
      "colSpan",
      "dateTime",
      "dir",
      "headers",
      "height",
      "id",
      "lang",
      "name",
      "noWrap",
      "open",
      "rowSpan",
      "scope",
      "start",
      "summary",
      "title",
      "vAlign",
      "width",
    ],
  },
  clobber: ["ariaDescribedBy", "ariaLabelledBy", "id", "name"],
  clobberPrefix: "user-content-",
  protocols: {
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
  required: { input: { disabled: true, type: "checkbox" } },
  strip: [
    "embed",
    "form",
    "iframe",
    "math",
    "noscript",
    "object",
    "script",
    "select",
    "style",
    "svg",
    "template",
    "textarea",
    "title",
  ],
  tagNames: [
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "dd",
    "del",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "input",
    "ins",
    "kbd",
    "li",
    "ol",
    "p",
    "pre",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "section",
    "span",
    "strike",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "tt",
    "ul",
    "var",
  ],
};

// Harden is the last gate. By the time it runs every link is already an
// absolute http(s)/mailto address or an in-page anchor and no image is left
// (see settleReadmeLinks), so it only has something to do if that went wrong —
// and then a link or image it refuses is left as its plain text.
const readmeHardenOptions = {
  allowDataImages: false,
  allowedImagePrefixes: ["*"],
  allowedLinkPrefixes: ["*"],
  allowedProtocols: [],
  imageBlockPolicy: "text-only",
  linkBlockPolicy: "text-only",
};

function stringProperty(value: HastElement["properties"][string]) {
  return typeof value === "string" ? value : undefined;
}

function element(
  tagName: string,
  properties: HastElement["properties"],
  children: HastChild[],
): HastElement {
  return { children, properties, tagName, type: "element" };
}

type ReadmeLinkOptions = {
  baseUrl?: UntrustedMarkdownBaseUrl;
  imagePlaceholder: string;
};

/**
 * Settles every link and image of a README once it is sanitized, before
 * harden, which would otherwise cut a relative reference off:
 * - a link's address resolves against `baseUrl.blob` (see
 *   untrustedMarkdownLink); one that does not resolve becomes its text;
 * - an image is never loaded. It becomes its alt text in brackets, linked to
 *   the picture (resolved against `baseUrl.raw`) when that has a safe address,
 *   except inside a link — a badge — where the link around it is the one that
 *   matters and a second one would nest.
 *
 * Streamdown caches a processor per plugin name and JSON of its options, so the
 * options must say everything that changes the output (they do: plain data).
 */
function settleReadmeLinks({ baseUrl, imagePlaceholder }: ReadmeLinkOptions) {
  const settle = (children: HastChild[], insideLink: boolean): HastChild[] =>
    children.map((node) => {
      if (node.type !== "element") return node;
      if (node.tagName === "img") {
        const alt = stringProperty(node.properties.alt)?.trim();
        const label: HastChild = {
          type: "text",
          value: `[${alt || imagePlaceholder}]`,
        };
        const link = insideLink
          ? null
          : untrustedMarkdownLink(
              stringProperty(node.properties.src),
              baseUrl?.raw,
            );
        return link?.kind === "external"
          ? element("a", { href: link.href }, [label])
          : element("span", {}, [label]);
      }
      if (node.tagName === "a") {
        const link = untrustedMarkdownLink(
          stringProperty(node.properties.href),
          baseUrl?.blob,
        );
        if (link.kind === "text") {
          return element("span", {}, settle(node.children, insideLink));
        }
        node.properties.href = link.href;
        node.children = settle(node.children, true);
        return node;
      }
      node.children = settle(node.children, insideLink);
      return node;
    });
  return (tree: { children: HastChild[] }) => {
    tree.children = settle(tree.children, false);
  };
}

function readmeRehypePlugins(options: ReadmeLinkOptions): Pluggable[] {
  return [
    defaultRehypePlugins.raw!,
    withOptions("sanitize", readmeSanitizeSchema),
    [settleReadmeLinks, options],
    withOptions("harden", readmeHardenOptions),
  ];
}

// Syntax highlighting only — no mermaid or math, which would execute
// third-party diagram/TeX source in the visitor's browser.
const plugins = { code };

// The document is embedded in a page that already has its <h1> (the skill's or
// server's name), so its own headings sit one level down: `# Title` is an <h2>.
// Sizes stay what a reader expects of each level in the source. A README
// centres its title with `<h1 align="center">`; markdown's own headings never
// carry an alignment.
const headingClass = "mt-6 mb-2 font-semibold";
const headingAlignClass = new Map([
  ["center", "text-center"],
  ["justify", "text-justify"],
  ["left", "text-left"],
  ["right", "text-right"],
]);

type HeadingProps = ComponentProps<"h1"> & ExtraProps;

function heading(
  Tag: "h2" | "h3" | "h4" | "h5" | "h6" | "p",
  sizeClass: string,
): ComponentType<HeadingProps> {
  return function Heading({ children, node }: HeadingProps) {
    const align = stringProperty(node?.properties.align)?.toLowerCase();
    const alignClass = align ? headingAlignClass.get(align) : undefined;
    return (
      <Tag
        className={[headingClass, sizeClass, alignClass]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </Tag>
    );
  };
}

const headings: Pick<Components, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"> = {
  h1: heading("h2", "text-2xl"),
  h2: heading("h3", "text-xl"),
  h3: heading("h4", "text-lg"),
  h4: heading("h5", "text-base"),
  h5: heading("h6", "text-sm"),
  h6: heading("p", "text-sm"),
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
    // link to the image when it has a safe address. (A README's images are
    // settled the same way before they get here: settleReadmeLinks.)
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
 * `mode` is how much of the document's own HTML becomes markup:
 * - `skill`: none. A SKILL.md's tags (`<example>`, `<Good>`) are its author's
 *   markers and show as the text they typed ({@link skillRehypePlugins}).
 * - `readme`: what READMEs are written with (`<p align="center">`, `<img>`,
 *   `<details>`, `<br>`), through a strict allow-list; scripts, styles,
 *   frames, forms and event handlers never ({@link readmeSanitizeSchema}).
 *
 * In both, remote images are not loaded and nothing executable (mermaid, math)
 * runs.
 */
export type UntrustedMarkdownProps = {
  children: string;
  /** The localized word shown for an image that is not loaded, e.g. "Image". */
  imagePlaceholder: string;
} & (
  | { baseUrl?: never; mode: "skill" }
  | {
      /**
       * The README's own address at its pinned commit, which its relative
       * links and images resolve against. Without it they render as text.
       */
      baseUrl?: UntrustedMarkdownBaseUrl;
      mode: "readme";
    }
);

/** Markdown someone else wrote, rendered so it cannot act on our page. */
export function UntrustedMarkdown({
  baseUrl,
  children,
  imagePlaceholder,
  mode,
}: UntrustedMarkdownProps) {
  const components = useMemo(
    () => untrustedMarkdownComponents(imagePlaceholder),
    [imagePlaceholder],
  );
  const blob = baseUrl?.blob;
  const raw = baseUrl?.raw;
  const rehypePlugins = useMemo(
    () =>
      mode === "skill"
        ? skillRehypePlugins
        : readmeRehypePlugins({
            baseUrl: blob && raw ? { blob, raw } : undefined,
            imagePlaceholder,
          }),
    [blob, imagePlaceholder, mode, raw],
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
      rehypePlugins={rehypePlugins}
      urlTransform={defaultUrlTransform}
    >
      {mode === "skill" ? isolateSkillMarkerTags(children) : children}
    </Streamdown>
  );
}
