import { compactArtifactText } from "./artifact-text";

export function stripVideoPresentationMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\s*\[\s*citation:[^\]]+]\s*/gi, " ")
    .replace(/\s*【\s*citation:[^】]+】\s*/gi, " ")
    .replace(/\s*\(\s*citation:[^)]+\)\s*/gi, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactVideoPresentationSourceText(
  value: string,
  maxLength = 800,
): string {
  return compactArtifactText(stripVideoPresentationMarkdown(value), maxLength);
}

export function sanitizeVideoPresentationFileBase(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[/\\?%*:|"<>]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return sanitized || "video-presentation";
}

export function buildVideoPresentationProjectFileName(value: string): string {
  return `${sanitizeVideoPresentationFileBase(value)}.video-presentation.json`;
}
