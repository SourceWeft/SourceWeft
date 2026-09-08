import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { ARTIFACT_LIMITS } from "@sourceweft/contracts/artifact-files";
import {
  HTML_ARTIFACT_METADATA_NAME,
  htmlArtifactMetadataSchema,
} from "@sourceweft/contracts/html-artifact";
import { ArtifactPublishError } from "../schemas";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

function invalid(message: string): never {
  throw new ArtifactPublishError("HTML_DOCUMENT_INVALID", message);
}

function resourceError(message: string): never {
  throw new ArtifactPublishError("HTML_RESOURCE_UNRESOLVED", message);
}

function checkResource(value: string, location: string) {
  if (!value.startsWith("data:") && !value.startsWith("#")) {
    resourceError(
      `${location} must be embedded in the HTML: ${value.slice(0, 160)}`,
    );
  }
}

function cssUnescape(value: string) {
  return value.replace(
    /\\([a-f\d]{1,6})\s?|\\([^\r\n])/giu,
    (_, hex: string | undefined, char: string) =>
      hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char,
  );
}

function checkCss(css: string) {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return invalid("CSS could not be parsed");
  }
  root.walkAtRules((rule) => {
    if (["import", "document"].includes(cssUnescape(rule.name).toLowerCase())) {
      resourceError(`CSS @${rule.name} must be resolved before publication`);
    }
  });
  root.walkDecls((declaration) => {
    valueParser(declaration.value).walk((node) => {
      if (node.type !== "function") return;
      const name = cssUnescape(node.value).toLowerCase();
      if (name === "url") {
        const nodes = node.nodes.filter(
          (child) => child.type !== "space" && child.type !== "comment",
        );
        if (
          nodes.length !== 1 ||
          !["word", "string"].includes(nodes[0]!.type)
        ) {
          resourceError("CSS url() must have one resolvable embedded resource");
        }
        checkResource(
          cssUnescape(nodes[0]!.value).trim(),
          `CSS ${declaration.prop}`,
        );
      }
      if (name === "image-set" || name === "-webkit-image-set") {
        for (const child of node.nodes) {
          if (child.type === "string")
            checkResource(cssUnescape(child.value), "CSS image-set");
        }
      }
    });
  });
}

/** Read URL tokens without splitting the commas inside data URLs. */
function srcsetUrls(input: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /[\s,]/u.test(input[index]!)) index++;
    const start = index;
    while (index < input.length && !/\s/u.test(input[index]!)) index++;
    const token = input.slice(start, index);
    if (!token) break;
    urls.push(token.replace(/,+$/u, ""));
    if (token.endsWith(",")) continue;
    let depth = 0;
    while (index < input.length) {
      const char = input[index++]!;
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) break;
    }
  }
  return urls;
}

export function validateHtmlBytes(bytes: Uint8Array) {
  if (bytes.byteLength === 0)
    throw new ArtifactPublishError("ARTIFACT_FILE_EMPTY");
  if (bytes.byteLength > ARTIFACT_LIMITS.htmlBytes)
    throw new ArtifactPublishError("ARTIFACT_FILE_TOO_LARGE");
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("HTML must be valid UTF-8");
  }
  if (html.includes("\0")) invalid("HTML contains a null character");
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "html",
  );
  if (!root?.sourceCodeLocation?.startTag || !root.sourceCodeLocation.endTag) {
    invalid(
      "Publish a complete HTML document with an opening and closing html element",
    );
  }
  let metadata = htmlArtifactMetadataSchema.parse({ schemaVersion: 1 });
  let foundMetadata = false;
  let utf8Declared =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const visit = (node: Node): void => {
    if ("tagName" in node) {
      const attrs = new Map(
        node.attrs.map((attr) => [
          attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name,
          attr.value,
        ]),
      );
      const tag = node.tagName.toLowerCase();
      if (["iframe", "frame", "object", "embed", "base"].includes(tag))
        invalid(`HTML ${tag} is not supported in a self-contained artifact`);
      if (tag === "meta") {
        const httpEquiv = attrs.get("http-equiv")?.toLowerCase();
        const charset = attrs.get("charset")?.trim().toLowerCase();
        if (charset && charset !== "utf-8" && charset !== "utf8")
          invalid("HTML charset must be UTF-8");
        if (
          charset &&
          Buffer.byteLength(
            html.slice(0, node.sourceCodeLocation?.endOffset ?? 1025),
            "utf8",
          ) <= 1024
        )
          utf8Declared = true;
        if (httpEquiv === "refresh")
          invalid("HTML cannot redirect during preview");
        if (attrs.get("name") === HTML_ARTIFACT_METADATA_NAME) {
          if (foundMetadata) invalid("Duplicate artifact metadata");
          foundMetadata = true;
          try {
            metadata = htmlArtifactMetadataSchema.parse(
              JSON.parse(attrs.get("content") ?? ""),
            );
          } catch {
            invalid("Artifact metadata does not match the supported schema");
          }
        }
      }
      for (const [name, value] of attrs) {
        if (name === "style") checkCss(`element { ${value} }`);
        if (name === "srcset" || name === "imagesrcset") {
          for (const url of srcsetUrls(value))
            checkResource(url, `${tag}.${name}`);
        }
        if (name === "src" || name === "poster" || name === "background") {
          if (tag === "script")
            resourceError(
              "Scripts must be inline, including bundled libraries",
            );
          checkResource(value.trim(), `${tag}.${name}`);
        }
        if (name === "href" || name === "xlink:href") {
          if (tag === "a" && !value.startsWith("#"))
            resourceError("Navigation links must stay within the document");
          checkResource(value.trim(), `${tag}.${name}`);
        }
        if (["action", "formaction", "ping", "srcdoc"].includes(name)) {
          resourceError(
            `${tag}.${name} is not supported by the local execution policy`,
          );
        }
      }
      if (tag === "style")
        checkCss(
          node.childNodes
            .map((child) => ("value" in child ? child.value : ""))
            .join(""),
        );
      if ("content" in node) visit(node.content);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(document);
  if (!utf8Declared)
    invalid(
      "Declare UTF-8 with a BOM or meta charset within the first 1024 bytes for standalone downloads",
    );
  return {
    metadata,
    contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    validation: {
      policyVersion: "html/1" as const,
      checks: ["utf8", "document", "resources", "metadata", "size"] as const,
    },
  };
}
