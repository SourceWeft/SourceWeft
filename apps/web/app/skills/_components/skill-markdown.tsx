"use client";

import { code } from "@streamdown/code";
import {
  defaultRehypePlugins,
  defaultUrlTransform,
  Streamdown,
  type Components,
} from "streamdown";

import { isolateSkillMarkerTags, untrustedMarkdownLink } from "./skills-format";
import { skillsCopy } from "./skills-public-copy";

// SKILL.md is third-party text. Streamdown's default pipeline is
// raw → sanitize → harden, where `raw` (rehype-raw) is what turns embedded HTML
// into real elements. Leaving it out means HTML in the markdown never becomes
// markup: it is shown as the literal text the author typed (skills often use
// XML-like tags such as <example> in their instructions, so dropping it would
// lose content). Sanitize and harden still run over what markdown itself made.
const rehypePlugins = [
  defaultRehypePlugins.sanitize!,
  defaultRehypePlugins.harden!,
];

// Syntax highlighting only — no mermaid or math, which would execute
// third-party diagram/TeX source in the visitor's browser.
const plugins = { code };

const components: Components = {
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
    const label = alt?.trim() || skillsCopy.detail.imagePlaceholder;
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

export function SkillMarkdown({ children }: { children: string }) {
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
      {isolateSkillMarkerTags(children)}
    </Streamdown>
  );
}
