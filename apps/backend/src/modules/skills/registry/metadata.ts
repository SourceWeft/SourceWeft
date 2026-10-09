import { marked, type Token, type Tokens } from "marked";
import {
  isAgentSkillName,
  isSafeSkillDirName,
  sha256,
} from "@sourceweft/skill-format";
import { parseSkillFrontmatter, SkillParseError } from "../frontmatter";

import { skillMetadataSource as registryMetadataSource } from "@sourceweft/skill-format";
export { registryMetadataSource };
export function hasRegistryFrontmatter(content: string): boolean {
  return /^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(registryMetadataSource(content));
}
function flatten(tokens: Token[] = []): string {
  return tokens
    .map((token) => {
      if (["image", "html"].includes(token.type)) return "";
      if (token.type === "br") return " ";
      const nested = (token as { tokens?: Token[] }).tokens;
      return nested
        ? flatten(nested)
        : ((token as { text?: string }).text ?? "");
    })
    .join("");
}
function plain(tokens: Token[] = []): string {
  return flatten(tokens).replace(/\s+/g, " ").trim();
}
function textBlock(tokens: Token[]): string | undefined {
  for (const token of tokens) {
    if (token.type === "paragraph" || token.type === "text") {
      const value = plain((token as Tokens.Paragraph).tokens);
      if (value) return value;
    } else if (token.type === "blockquote") {
      const value = textBlock((token as Tokens.Blockquote).tokens);
      if (value) return value;
    } else if (token.type === "list") {
      for (const item of (token as Tokens.List).items) {
        const value = textBlock(item.tokens);
        if (value) return value;
      }
    }
  }
}
export function readRegistryMetadata(
  content: string,
  fallbackName: string,
): {
  metadata: Record<string, unknown>;
  derived: boolean;
} {
  const source = registryMetadataSource(content);
  let explicit: Record<string, unknown> | null;
  try {
    explicit = parseSkillFrontmatter(source);
  } catch (error) {
    if (error instanceof SkillParseError && source !== content) {
      const prefix = content.slice(0, content.length - source.length);
      throw new SkillParseError(
        error.message,
        error.line === undefined
          ? undefined
          : error.line + (prefix.match(/\n/g)?.length ?? 0),
        error.column,
      );
    }
    throw error;
  }
  if (explicit) return { metadata: explicit, derived: false };
  let name: string | undefined,
    description: string | undefined,
    preamble: string | undefined;
  for (const token of marked.lexer(content)) {
    if (token.type === "heading") {
      if (!name && (token as Tokens.Heading).depth === 1)
        name = plain((token as Tokens.Heading).tokens) || undefined;
      continue;
    }
    const text = textBlock([token]);
    if (!text) continue;
    if (name) {
      description = text;
      break;
    }
    preamble ??= text;
  }
  description ??= preamble;
  if (!name && description) name = fallbackName;
  return {
    metadata: { ...(name && { name }), ...(description && { description }) },
    derived: true,
  };
}
/** Human titles and filesystem identifiers have distinct contracts. */
export function registryInstallName(
  originalName: string,
  fallbackName: string,
): string {
  if (isAgentSkillName(originalName) && isSafeSkillDirName(originalName))
    return originalName;
  const normalized = (value: string) =>
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const base = normalized(originalName) || normalized(fallbackName) || "skill";
  return `${base.slice(0, 55).replace(/-+$/g, "")}-${sha256(Buffer.from(originalName)).slice(0, 8)}`;
}
