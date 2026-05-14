import path from "node:path";
import type { SkillManifestJson } from "../../../shared/db/schema";
import {
  isAgentToolName,
  isSkillDeclarableAgentTool,
} from "../agent/tool-registry";
import type { SkillBundleFile } from "./builtin";
import type { SkillCommandDescriptor } from "./types";

const COMMAND_FILE_PATTERN = /^commands\/(.+)\.md$/i;
const COMMAND_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseFrontmatter(content: string) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return {
      body: content.trim(),
      data: {} as Record<string, unknown>,
    };
  }

  const data: Record<string, unknown> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!key) {
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      data[key] = raw
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }
    data[key] = raw.replace(/^["']|["']$/g, "");
  }

  return {
    body: content.slice(match[0].length).trim(),
    data,
  };
}

function normalizeCommandPath(inputPath: string) {
  const normalized = path.posix.normalize(inputPath.replace(/\\/g, "/"));
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  return normalized;
}

function commandNameFromPath(filePath: string) {
  const normalized = normalizeCommandPath(filePath);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(COMMAND_FILE_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  const parts = match[1].split("/");
  if (!parts.every((part) => COMMAND_SEGMENT_PATTERN.test(part))) {
    throw new Error(`Invalid command file path '${filePath}'`);
  }
  return parts.join(".");
}

function normalizeString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : undefined;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function normalizeTools(value: unknown) {
  const tools = normalizeStringArray(value);
  if (!tools) {
    return undefined;
  }
  if (tools.some((toolName) => !isAgentToolName(toolName))) {
    throw new Error("Command references an unknown tool");
  }
  return tools;
}

function displayNameFromCommandName(name: string) {
  return name
    .split(/[.\-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function parseSkillCommands(input: {
  files: SkillBundleFile[];
  skillSlug: string;
}): SkillCommandDescriptor[] {
  const commands = input.files
    .filter((file) => commandNameFromPath(file.path))
    .map((file) => {
      const name = commandNameFromPath(file.path);
      if (!name) {
        throw new Error(`Invalid command file path '${file.path}'`);
      }
      const { body, data } = parseFrontmatter(file.contentText);
      const description =
        normalizeString(data.description, 512) ||
        body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ||
        `Run ${name}`;
      const title = normalizeString(data.title, 128);
      const tools = normalizeTools(data.tools ?? data["allowed-tools"]);
      const skillSlugs =
        normalizeStringArray(data.skills) ?? [input.skillSlug];
      const slash = normalizeBoolean(data.slash);
      return {
        id: `${input.skillSlug}:${name}`,
        name,
        canonicalName: `/${input.skillSlug}:${name}`,
        displayName: title ?? displayNameFromCommandName(name),
        description,
        path: file.path,
        ...(normalizeString(data["argument-hint"], 256)
          ? { argumentHint: normalizeString(data["argument-hint"], 256) }
          : {}),
        ...(title ? { title } : {}),
        skillSlugs,
        ...(tools ? { tools } : {}),
        ...(normalizeString(data.model, 512)
          ? { model: normalizeString(data.model, 512) }
          : {}),
        ...(slash !== undefined ? { slash } : {}),
        instruction: body,
      };
    });

  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.canonicalName)) {
      throw new Error(`Duplicate command '${command.canonicalName}'`);
    }
    seen.add(command.canonicalName);
  }
  return commands.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
}

export function publicSkillCommands(
  commands: SkillCommandDescriptor[] | undefined,
): NonNullable<SkillManifestJson["commands"]> | undefined {
  if (!commands?.length) {
    return undefined;
  }
  return commands.map(({ instruction: _instruction, ...command }) => command);
}

export function validateManifestCommandTools(manifest: SkillManifestJson) {
  for (const command of manifest.commands ?? []) {
    if (command.tools?.some((toolName) => !isSkillDeclarableAgentTool(toolName))) {
      throw new Error("Command references a tool that cannot be declared by skills");
    }
  }
}
