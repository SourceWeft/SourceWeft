import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ConnectionCandidate,
  McpRepositoryAssessment,
  ParsedTool,
  PreparedGitHubRepository,
  ReadmeParseResult,
  RegistryInput,
  RegistryServerJson,
  StaticParseResult,
} from "../types";

const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

const sourceExtensions = new Set([".go", ".js", ".jsx", ".py", ".ts", ".tsx"]);
const maxSourceFiles = 250;
const maxSourceFileBytes = 300_000;
const mcpRuntimePattern =
  /(@modelcontextprotocol\/sdk|modelcontextprotocol\/go-sdk|github\.com\/mark3labs\/mcp-go|FastMCP|fastmcp|mcp\.server|mcp\.New(?:Server|Tool)|ModelContextProtocol|McpServer|StdioServerTransport|SSEServerTransport|StreamableHTTPServerTransport|tools\/list|resources\/list|prompts\/list|initializeRequestSchema)/;

async function exists(filePath: string) {
  return Boolean(await stat(filePath).catch(() => null));
}

async function readText(filePath: string) {
  return readFile(filePath, "utf8");
}

function relativeTo(root: string, filePath: string) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function walkFiles(root: string, limit = 2_000): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    if (files.length >= limit) {
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(path.join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  await visit(root);
  return files;
}

function classifyRisk(name: string) {
  const lower = name.toLowerCase();
  if (/(delete|destroy|remove|drop|purge|reset|revoke)/.test(lower)) {
    return "destructive" as const;
  }
  if (/(create|update|write|edit|merge|close|open|send|post|put|patch)/.test(lower)) {
    return "write" as const;
  }
  if (/(get|list|read|search|fetch|find|query|lookup)/.test(lower)) {
    return "read" as const;
  }
  return "unknown" as const;
}

function humanize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toolFrom(input: {
  confidence: number;
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
  source: ParsedTool["source"];
  sourcePath?: string;
}): ParsedTool {
  return {
    name: input.name,
    title: humanize(input.name),
    description: input.description?.trim(),
    inputSchema: input.inputSchema ?? {},
    annotations: {},
    risk: classifyRisk(input.name),
    confidence: input.confidence,
    source: input.source,
    sourcePath: input.sourcePath,
  };
}

function parseMcpName(readme: string) {
  return readme.match(/<!--\s*mcp-name:\s*([^\s]+)\s*-->/i)?.[1];
}

function firstParagraph(readme: string) {
  const withoutHeading = readme
    .replace(/^#\s+.+$/m, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const paragraph = withoutHeading
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(
      (part) =>
        part &&
        !part.startsWith(">") &&
        !part.startsWith("```") &&
        !part.startsWith("[![") &&
        !part.startsWith("![") &&
        !/^<p\b/i.test(part),
    );
  return paragraph?.replace(/\s+/g, " ");
}

function jsonTypeFromDescription(value: string) {
  const lower = value.toLowerCase();
  if (lower.includes("integer")) {
    return "integer";
  }
  if (lower.includes("number") || lower.includes("float")) {
    return "number";
  }
  if (lower.includes("boolean") || lower.includes("bool")) {
    return "boolean";
  }
  if (lower.includes("array") || lower.includes("list")) {
    return "array";
  }
  return "string";
}

function parseReadmeTools(readme: string, sourcePath: string): ParsedTool[] {
  const section = readme.match(
    /#{2,4}\s+Available Tools\s*\n(?<body>[\s\S]*?)(?=\n#{2,4}\s+\S|$)/i,
  )?.groups?.body;
  if (!section) {
    return [];
  }

  const tools: ParsedTool[] = [];
  const lines = section.split("\n");
  let current:
    | {
        description?: string;
        properties: Record<string, Record<string, unknown>>;
        required: string[];
        toolName: string;
      }
    | undefined;

  function flush() {
    if (!current) {
      return;
    }
    const inputSchema =
      Object.keys(current.properties).length > 0
        ? {
            type: "object",
            properties: current.properties,
            required: current.required,
          }
        : {};
    tools.push(
      toolFrom({
        confidence: 0.72,
        description: current.description,
        inputSchema,
        name: current.toolName,
        source: "readme",
        sourcePath,
      }),
    );
  }

  for (const line of lines) {
    const toolMatch = line.match(/^\s*-\s+`([^`]+)`\s*(?:[-:]\s*(.+))?$/);
    if (toolMatch) {
      flush();
      current = {
        description: toolMatch[2],
        properties: {},
        required: [],
        toolName: toolMatch[1] ?? "",
      };
      continue;
    }
    const argMatch = line.match(
      /^\s{2,}-\s+`([^`]+)`\s+\(([^)]*)\):\s*(.+)$/i,
    );
    if (argMatch && current) {
      const name = argMatch[1] ?? "";
      const typeInfo = argMatch[2] ?? "";
      current.properties[name] = {
        type: jsonTypeFromDescription(typeInfo),
        description: argMatch[3],
      };
      if (typeInfo.toLowerCase().includes("required")) {
        current.required.push(name);
      }
    }
  }
  flush();
  return tools.filter((tool) => tool.name);
}

function codeBlocks(markdown: string) {
  return [...markdown.matchAll(/```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g)].map(
    (match) => ({
      language: (match[1] ?? "").toLowerCase(),
      body: match[2] ?? "",
    }),
  );
}

function parseJsonBlock(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseMcpConfigConnections(block: string, sourcePath: string) {
  const parsed = parseJsonBlock(block);
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const root = parsed as Record<string, unknown>;
  const servers =
    (root.mcpServers as Record<string, unknown> | undefined) ??
    ((root.mcp as Record<string, unknown> | undefined)?.servers as
      | Record<string, unknown>
      | undefined);
  if (!servers || typeof servers !== "object") {
    return [];
  }

  const connections: ConnectionCandidate[] = [];
  for (const [serverName, rawConfig] of Object.entries(servers)) {
    if (!rawConfig || typeof rawConfig !== "object") {
      continue;
    }
    const config = rawConfig as Record<string, unknown>;
    const command = typeof config.command === "string" ? config.command : undefined;
    const args = Array.isArray(config.args)
      ? config.args.filter((arg): arg is string => typeof arg === "string")
      : undefined;
    let dockerImage: string | undefined;
    if (command === "docker" && args) {
      for (let index = args.length - 1; index >= 0; index -= 1) {
        const value = args[index];
        if (value && !value.startsWith("-")) {
          dockerImage = value;
          break;
        }
      }
    }
    const env = config.env && typeof config.env === "object" ? config.env : {};
    const requiredSecrets = Object.keys(env as Record<string, unknown>).filter(
      (name) => /(token|key|secret|password|credential)/i.test(name),
    );
    connections.push({
      args,
      authRequired: requiredSecrets.length > 0,
      command,
      confidence: 0.7,
      dockerImage,
      requiredSecrets,
      runtimeHint: command,
      source: "readme",
      sourcePath,
      transport: "stdio",
      identifier: serverName,
    });
  }
  return connections;
}

function parseShellConnection(line: string, sourcePath: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }
  if (trimmed.includes("@modelcontextprotocol/inspector")) {
    return undefined;
  }
  const dockerMatch = trimmed.match(/\bdocker\s+run\b[\s\S]*?\s([^\s]+:[^\s]+|[a-z0-9./_-]+\/[a-z0-9./_-]+)(?:\s|$)/i);
  if (dockerMatch) {
    return {
      confidence: 0.56,
      dockerImage: dockerMatch[1],
      registryType: "oci",
      runtimeHint: "docker",
      source: "readme" as const,
      sourcePath,
      transport: "stdio" as const,
    };
  }
  const uvxMatch = trimmed.match(/\buvx\s+([@a-zA-Z0-9._/-]+)/);
  if (uvxMatch) {
    return {
      confidence: 0.55,
      identifier: uvxMatch[1],
      registryType: "pypi",
      runtimeHint: "uvx",
      source: "readme" as const,
      sourcePath,
      transport: "stdio" as const,
    };
  }
  const npxMatch = trimmed.match(/\bnpx\s+(?:-y\s+)?([@a-zA-Z0-9._/-]+)/);
  if (npxMatch) {
    return {
      confidence: 0.55,
      identifier: npxMatch[1],
      registryType: "npm",
      runtimeHint: "npx",
      source: "readme" as const,
      sourcePath,
      transport: "stdio" as const,
    };
  }
  return undefined;
}

function isLikelyMcpInstallCommand(line: string) {
  return /(@modelcontextprotocol|modelcontextprotocol|model-context-protocol|fastmcp|\bmcp[-_/]|[-_/]mcp\b|\/mcp\b|mcp-server|server-mcp)/i.test(
    line,
  );
}

function parseInstallCommands(readme: string, sourcePath: string) {
  const installCommands: string[] = [];
  const connections: ConnectionCandidate[] = [];
  for (const block of codeBlocks(readme)) {
    const body = block.body.trim();
    if (!body) {
      continue;
    }
    if (body.includes("mcpServers") || body.includes('"mcp"')) {
      installCommands.push(body);
      connections.push(...parseMcpConfigConnections(body, sourcePath));
      continue;
    }
    for (const line of body.split("\n")) {
      if (/\b(uvx|npx|docker run|python -m|pip install)\b/.test(line)) {
        if (line.includes("@modelcontextprotocol/inspector")) {
          continue;
        }
        installCommands.push(line.trim());
        if (isLikelyMcpInstallCommand(line)) {
          const connection = parseShellConnection(line, sourcePath);
          if (connection) {
            connections.push(connection);
          }
        }
      }
    }
  }
  const connectionKeys = new Set<string>();
  const uniqueConnections = connections.filter((connection) => {
    const key = JSON.stringify({
      command: connection.command,
      args: connection.args,
      dockerImage: connection.dockerImage,
      identifier: connection.identifier,
      runtimeHint: connection.runtimeHint,
      transport: connection.transport,
    });
    if (connectionKeys.has(key)) {
      return false;
    }
    connectionKeys.add(key);
    return true;
  });
  return {
    connections: uniqueConnections,
    installCommands: [...new Set(installCommands)],
  };
}

function readmeMentionsMcpServer(readme: string) {
  const lower = readme.toLowerCase();
  if (!lower.includes("mcp")) {
    return false;
  }
  return /\bmcp\s+(server|tool|client|config|configuration|servers)\b|\bmodel context protocol\b/.test(
    lower,
  );
}

function isExplicitPublicMcpInstallCommand(line: string) {
  return (
    /\b(uvx|npx)\b/i.test(line) &&
    /(@modelcontextprotocol|modelcontextprotocol|model-context-protocol|fastmcp|\bmcp[-_/]|[-_/]mcp\b|\/mcp\b|mcp-server|server-mcp)/i.test(
      line,
    )
  );
}

async function findServerJson(workDir: string) {
  const direct = path.join(workDir, "server.json");
  if (await exists(direct)) {
    return direct;
  }
  const files = await walkFiles(workDir, 500);
  return files.find((file) => path.basename(file) === "server.json");
}

async function findReadme(workDir: string) {
  const entries = await readdir(workDir).catch(() => []);
  const direct = entries.find((entry) => /^readme(\.[a-z0-9_-]+)?$/i.test(entry));
  if (direct) {
    return path.join(workDir, direct);
  }
  const files = await walkFiles(workDir, 500);
  return files.find((file) => /^readme(\.[a-z0-9_-]+)?$/i.test(path.basename(file)));
}

function normalizeTransport(value: string | undefined) {
  if (value === "streamable-http" || value === "streamable_http") {
    return "streamable_http" as const;
  }
  if (value === "sse") {
    return "sse" as const;
  }
  return "stdio" as const;
}

function secretNames(inputs: RegistryInput[] | undefined) {
  const names: string[] = [];
  for (const input of inputs ?? []) {
    if (!input.isRequired && !input.isSecret) {
      continue;
    }
    for (const variableName of Object.keys(input.variables ?? {})) {
      names.push(variableName);
    }
    const envName = input.value?.match(/^([A-Za-z_][A-Za-z0-9_]*)=\{[^}]+\}$/)?.[1];
    if (envName) {
      names.push(envName);
      continue;
    }
    const name = input.name ?? input.valueHint ?? input.placeholder;
    if (name) {
      names.push(name);
    }
  }
  return [...new Set(names)];
}

function headerNames(headers: RegistryInput[] | undefined) {
  return (headers ?? [])
    .map((header) => header.name)
    .filter((value): value is string => Boolean(value));
}

function connectionsFromServerJson(
  serverJson: RegistryServerJson,
  sourcePath: string,
) {
  const connections: ConnectionCandidate[] = [];
  for (const remote of serverJson.remotes ?? []) {
    const headers = headerNames(remote.headers);
    connections.push({
      authRequired: headers.length > 0,
      confidence: 0.95,
      endpointUrl: remote.url,
      headerNames: headers,
      requiredSecrets: headers,
      source: "server-json",
      sourcePath,
      transport: normalizeTransport(remote.type),
    });
  }
  for (const pkg of serverJson.packages ?? []) {
    const transport = normalizeTransport(pkg.transport?.type);
    const envSecrets = secretNames(pkg.environmentVariables);
    const runtimeSecrets = secretNames(pkg.runtimeArguments);
    const packageSecrets = secretNames(pkg.packageArguments);
    connections.push({
      authRequired: [...envSecrets, ...runtimeSecrets, ...packageSecrets].length > 0,
      confidence: 0.9,
      environmentVariables: pkg.environmentVariables,
      identifier: pkg.identifier,
      packageArguments: pkg.packageArguments,
      registryType: pkg.registryType,
      requiredSecrets: [...envSecrets, ...runtimeSecrets, ...packageSecrets],
      runtimeArguments: pkg.runtimeArguments,
      runtimeHint: pkg.runtimeHint,
      source: "server-json",
      sourcePath,
      transport,
    });
  }
  return connections;
}

async function parseReadme(
  readmePath: string,
  workDir: string,
): Promise<{
  connections: ConnectionCandidate[];
  readme: ReadmeParseResult;
}> {
  const content = await readText(readmePath);
  const sourcePath = relativeTo(workDir, readmePath);
  const install = parseInstallCommands(content, sourcePath);
  return {
    connections: install.connections,
    readme: {
      content,
      installCommands: install.installCommands,
      mcpName: parseMcpName(content),
      path: sourcePath,
      summary: firstParagraph(content),
      tools: parseReadmeTools(content, sourcePath),
    },
  };
}

function firstStringLiteral(value: string) {
  return value.match(/["'`]([^"'`]+)["'`]/)?.[1];
}

function stringLiterals(value: string) {
  return [...value.matchAll(/["'`]([^"'`]+)["'`]/g)].map(
    (match) => match[1] ?? "",
  );
}

function extractCallBlocks(source: string, token: string) {
  const blocks: string[] = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf(token, index);
    if (start === -1) {
      break;
    }
    let depth = 0;
    let end = start;
    let quote: string | undefined;
    for (; end < source.length; end += 1) {
      const char = source[end];
      const previous = source[end - 1];
      if (quote) {
        if (char === quote && previous !== "\\") {
          quote = undefined;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(start, end + 1));
          break;
        }
      }
    }
    index = end + 1;
  }
  return blocks;
}

function parsePythonModelSchemas(source: string) {
  const schemas = new Map<string, Record<string, unknown>>();
  const classRegex =
    /^class\s+([A-Za-z_][A-Za-z0-9_]*)\(BaseModel\):\s*\n([\s\S]*?)(?=\n\S|$)/gm;
  for (const match of source.matchAll(classRegex)) {
    const className = match[1];
    const body = match[2] ?? "";
    if (!className) {
      continue;
    }
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    const fieldRegex = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*([\s\S]*?)(?=\n\s+[A-Za-z_][A-Za-z0-9_]*:\s|\n\S|$)/gm;
    for (const field of body.matchAll(fieldRegex)) {
      const fieldName = field[1];
      const fieldBody = (field[2] ?? "").trim();
      const typeText = fieldBody.split(/\n/)[0] ?? "";
      if (!fieldName) {
        continue;
      }
      const description = fieldBody.match(/description=["']([^"']+)["']/)?.[1];
      const defaultMatch = fieldBody.match(/default\s*=\s*([^,\n)]+)/);
      properties[fieldName] = {
        type: jsonTypeFromDescription(typeText),
        ...(description ? { description } : {}),
        ...(defaultMatch?.[1] ? { default: defaultMatch[1].trim() } : {}),
      };
      if (
        !typeText.includes("| None") &&
        !typeText.includes("Optional") &&
        !defaultMatch
      ) {
        required.push(fieldName);
      }
    }
    schemas.set(className, { type: "object", properties, required });
  }
  return schemas;
}

function parsePythonTools(source: string, sourcePath: string) {
  const tools: ParsedTool[] = [];
  const schemas = parsePythonModelSchemas(source);
  for (const block of extractCallBlocks(source, "Tool(")) {
    const name = block.match(/name\s*=\s*["']([^"']+)["']/)?.[1];
    if (!name) {
      continue;
    }
    const description =
      block.match(/description\s*=\s*"""([\s\S]*?)"""/)?.[1] ??
      block.match(/description\s*=\s*["']([^"']+)["']/)?.[1];
    const schemaClass = block.match(/inputSchema\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.model_json_schema\(\)/)?.[1];
    tools.push(
      toolFrom({
        confidence: 0.82,
        description,
        inputSchema: schemaClass ? schemas.get(schemaClass) : undefined,
        name,
        source: "source",
        sourcePath,
      }),
    );
  }

  for (const match of source.matchAll(
    /@(?:[A-Za-z_][A-Za-z0-9_]*\.)?tool\(([^)]*)\)\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    const decoratorArgs = match[1] ?? "";
    const functionName = match[2];
    if (!functionName) {
      continue;
    }
    tools.push(
      toolFrom({
        confidence: 0.7,
        description: stringLiterals(decoratorArgs)[1],
        name: firstStringLiteral(decoratorArgs) ?? functionName,
        source: "source",
        sourcePath,
      }),
    );
  }
  return tools;
}

function sourceContainsMcpRuntime(source: string) {
  return mcpRuntimePattern.test(source);
}

function sourceContainsMcpEntrypoint(source: string) {
  return /\.(?:run|connect)\(\s*(?:[^)]*transport\s*=\s*["'](?:stdio|sse|streamable-http|http)["']|new\s+StdioServerTransport|new\s+SSEServerTransport|new\s+StreamableHTTPServerTransport)/s.test(
    source,
  );
}

function parseTsTools(source: string, sourcePath: string) {
  const tools: ParsedTool[] = [];
  for (const block of extractCallBlocks(source, ".tool(")) {
    const literals = stringLiterals(block);
    const name = literals[0];
    if (!name) {
      continue;
    }
    tools.push(
      toolFrom({
        confidence: 0.65,
        description: literals[1],
        name,
        source: "source",
        sourcePath,
      }),
    );
  }
  for (const block of extractCallBlocks(source, "tool(")) {
    const literals = stringLiterals(block);
    const name = literals[0];
    if (!name || tools.some((tool) => tool.name === name)) {
      continue;
    }
    tools.push(
      toolFrom({
        confidence: 0.55,
        description: literals[1],
        name,
        source: "source",
        sourcePath,
      }),
    );
  }
  return tools;
}

function parseGoTools(source: string, sourcePath: string) {
  return [...source.matchAll(/(?:mcp\.)?NewTool\(\s*"([^"]+)"/g)].map(
    (match) =>
      toolFrom({
        confidence: 0.65,
        name: match[1] ?? "",
        source: "source",
        sourcePath,
      }),
  );
}

async function parseSourceTools(workDir: string) {
  const files = await walkFiles(workDir);
  const tools: ParsedTool[] = [];
  let scanned = 0;
  for (const file of files) {
    if (scanned >= maxSourceFiles) {
      break;
    }
    const extension = path.extname(file);
    if (!sourceExtensions.has(extension)) {
      continue;
    }
    const fileStat = await stat(file).catch(() => null);
    if (!fileStat || fileStat.size > maxSourceFileBytes) {
      continue;
    }
    scanned += 1;
    const source = await readText(file);
    const sourcePath = relativeTo(workDir, file);
    if (!sourceContainsMcpRuntime(source)) {
      continue;
    }
    if (extension === ".py") {
      tools.push(...parsePythonTools(source, sourcePath));
    } else if (extension === ".go") {
      tools.push(...parseGoTools(source, sourcePath));
    } else {
      tools.push(...parseTsTools(source, sourcePath));
    }
  }
  const byName = new Map<string, ParsedTool>();
  for (const tool of tools) {
    const existing = byName.get(tool.name);
    if (!existing || existing.confidence < tool.confidence) {
      byName.set(tool.name, tool);
    }
  }
  return [...byName.values()].filter((tool) => tool.name);
}

async function parseSourceSignals(workDir: string) {
  const files = await walkFiles(workDir);
  const sourceSignals: McpRepositoryAssessment["signals"] = [];
  let scanned = 0;
  for (const file of files) {
    if (scanned >= maxSourceFiles) {
      break;
    }
    const extension = path.extname(file);
    if (!sourceExtensions.has(extension)) {
      continue;
    }
    const fileStat = await stat(file).catch(() => null);
    if (!fileStat || fileStat.size > maxSourceFileBytes) {
      continue;
    }
    scanned += 1;
    const source = await readText(file);
    if (!sourceContainsMcpRuntime(source)) {
      continue;
    }
    sourceSignals.push({
      confidence: 0.75,
      kind: "mcp-source",
      path: relativeTo(workDir, file),
      summary: "Source code imports or initializes an MCP runtime",
    });
    if (sourceSignals.length >= 8) {
      break;
    }
  }
  return sourceSignals;
}

async function parseEntrypointSignals(workDir: string) {
  const files = await walkFiles(workDir);
  const entrypointSignals: McpRepositoryAssessment["signals"] = [];
  let scanned = 0;
  for (const file of files) {
    if (scanned >= maxSourceFiles) {
      break;
    }
    const extension = path.extname(file);
    if (!sourceExtensions.has(extension)) {
      continue;
    }
    const fileStat = await stat(file).catch(() => null);
    if (!fileStat || fileStat.size > maxSourceFileBytes) {
      continue;
    }
    scanned += 1;
    const source = await readText(file);
    if (!sourceContainsMcpRuntime(source) || !sourceContainsMcpEntrypoint(source)) {
      continue;
    }
    entrypointSignals.push({
      confidence: 0.78,
      detail: { entry: "source" },
      kind: "mcp-entrypoint",
      path: relativeTo(workDir, file),
      summary: "Source code exposes a runnable MCP server transport entrypoint",
    });
    if (entrypointSignals.length >= 8) {
      break;
    }
  }
  return entrypointSignals;
}

async function parsePackageHints(workDir: string) {
  const hints: Record<string, unknown>[] = [];
  const packageJsonPath = path.join(workDir, "package.json");
  if (await exists(packageJsonPath)) {
    try {
      const content = JSON.parse(await readText(packageJsonPath)) as Record<
        string,
        unknown
      >;
      hints.push({
        type: "package.json",
        name: content.name,
        version: content.version,
        license: content.license,
        bin: content.bin,
        dependencies: content.dependencies,
        devDependencies: content.devDependencies,
        optionalDependencies: content.optionalDependencies,
        peerDependencies: content.peerDependencies,
      });
    } catch (error) {
      console.warn(
        `[mcp-static-parser] skipping malformed package.json at ${packageJsonPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const pyprojectPath = path.join(workDir, "pyproject.toml");
  if (await exists(pyprojectPath)) {
    const content = await readText(pyprojectPath);
    hints.push({
      type: "pyproject.toml",
      name: content.match(/^name\s*=\s*"([^"]+)"/m)?.[1],
      version: content.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
      dependencies: [...content.matchAll(/^\s*"([^"]+)"/gm)].map(
        (match) => match[1],
      ),
    });
  }
  return hints;
}

function packageHasMcpRuntime(hint: Record<string, unknown>) {
  const value = JSON.stringify(hint).toLowerCase();
  return (
    value.includes("@modelcontextprotocol/sdk") ||
    value.includes("modelcontextprotocol") ||
    value.includes("fastmcp")
  );
}

function valueLooksLikeMcpServer(value: unknown) {
  return (
    typeof value === "string" &&
    /(^|[/@_.-])(mcp|model-context-protocol)([/_.-]|$)|mcp-server|server-mcp/i.test(
      value,
    )
  );
}

function packageLooksLikeMcpServer(hint: Record<string, unknown>) {
  if (valueLooksLikeMcpServer(hint.name)) {
    return true;
  }
  const bin = hint.bin;
  if (typeof bin === "string" && valueLooksLikeMcpServer(bin)) {
    return true;
  }
  if (bin && typeof bin === "object") {
    return Object.keys(bin as Record<string, unknown>).some((name) =>
      valueLooksLikeMcpServer(name),
    );
  }
  return false;
}

function assessMcpRepository(input: {
  connections: ConnectionCandidate[];
  entrypointSignals: McpRepositoryAssessment["signals"];
  packageHints: Record<string, unknown>[];
  readme?: ReadmeParseResult;
  serverJson?: StaticParseResult["serverJson"];
  source: PreparedGitHubRepository;
  sourceSignals: McpRepositoryAssessment["signals"];
  sourceTools: ParsedTool[];
}): McpRepositoryAssessment {
  const signals: McpRepositoryAssessment["signals"] = [];

  if (input.serverJson) {
    signals.push({
      confidence: 0.95,
      kind: "server-json",
      path: input.serverJson.path,
      summary: "Found MCP registry server.json",
    });
  }

  for (const connection of input.connections) {
    signals.push({
      confidence: connection.confidence,
      kind: "mcp-config",
      path: connection.sourcePath,
      summary: `Found MCP ${connection.transport} connection configuration`,
    });
  }

  if (input.readme?.mcpName) {
    signals.push({
      confidence: 0.82,
      kind: "mcp-name",
      path: input.readme.path,
      summary: "README declares an mcp-name marker",
    });
  }

  if (input.readme && readmeMentionsMcpServer(input.readme.content)) {
    signals.push({
      confidence: 0.42,
      kind: "mcp-readme",
      path: input.readme.path,
      summary: "README explicitly describes MCP server usage",
    });
  }

  for (const command of input.readme?.installCommands ?? []) {
    if (!isExplicitPublicMcpInstallCommand(command)) {
      continue;
    }
    signals.push({
      confidence: 0.68,
      detail: { entry: "readme-install" },
      kind: "mcp-entrypoint",
      path: input.readme?.path,
      summary: "README exposes an MCP-specific install or launch command",
    });
  }

  for (const hint of input.packageHints) {
    if (!packageHasMcpRuntime(hint)) {
      continue;
    }
    signals.push({
      confidence: 0.7,
      kind: "mcp-package",
      summary: "Package metadata references an MCP runtime dependency",
    });
  }

  signals.push(...input.sourceSignals);
  signals.push(...input.entrypointSignals);

  if (input.sourceTools.length > 0 && input.sourceSignals.length > 0) {
    signals.push({
      confidence: 0.72,
      kind: "tool-registration",
      summary: `Found ${input.sourceTools.length} MCP tool registration patterns`,
    });
  }

  const confidence = Math.max(0, ...signals.map((signal) => signal.confidence));
  const configSignal = signals.some((signal) =>
    ["mcp-config", "server-json"].includes(signal.kind),
  );
  const explicitSubpath = Boolean(input.source.subpath);
  const packageIdentity = input.packageHints.some(packageLooksLikeMcpServer);
  const repoIdentity = valueLooksLikeMcpServer(input.source.repo);
  const packageSignal = signals.some((signal) => signal.kind === "mcp-package");
  const sourceSignal = signals.some((signal) => signal.kind === "mcp-source");
  const toolSignal = signals.some((signal) => signal.kind === "tool-registration");
  const readmeEntrypointSignal = signals.some(
    (signal) =>
      signal.kind === "mcp-entrypoint" &&
      signal.detail?.entry === "readme-install",
  );
  const sourceEntrypointSignal = signals.some(
    (signal) =>
      signal.kind === "mcp-entrypoint" && signal.detail?.entry === "source",
  );
  const publicEntrypointSignal =
    configSignal ||
    readmeEntrypointSignal ||
    ((explicitSubpath || repoIdentity || packageIdentity) &&
      sourceEntrypointSignal);
  const explicitManifestSignal = signals.some((signal) =>
    ["mcp-name", "server-json"].includes(signal.kind),
  );
  const definitionSignal =
    configSignal ||
    explicitManifestSignal ||
    packageSignal ||
    sourceSignal ||
    toolSignal;
  const isMcp = publicEntrypointSignal && definitionSignal;
  return {
    confidence,
    isMcp,
    reasons: isMcp
      ? signals.map((signal) => signal.summary)
      : [
          "No public installable or runnable MCP server entrypoint found",
        ],
    signals,
  };
}

export async function parseStaticRepository(
  source: PreparedGitHubRepository,
): Promise<StaticParseResult> {
  const warnings: string[] = [];
  const evidence: StaticParseResult["evidence"] = [];
  const connections: ConnectionCandidate[] = [];

  const serverJsonPath = await findServerJson(source.workDir);
  let serverJson: StaticParseResult["serverJson"];
  if (serverJsonPath) {
    const sourcePath = relativeTo(source.workDir, serverJsonPath);
    try {
      const content = JSON.parse(await readText(serverJsonPath)) as RegistryServerJson;
      serverJson = { content, path: sourcePath };
      connections.push(...connectionsFromServerJson(content, sourcePath));
      evidence.push({
        source: "server-json",
        path: sourcePath,
        summary: "Found MCP registry server.json",
      });
    } catch (error) {
      warnings.push(
        `Failed to parse server.json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const readmePath = await findReadme(source.workDir);
  let readme: ReadmeParseResult | undefined;
  if (readmePath) {
    const parsed = await parseReadme(readmePath, source.workDir);
    readme = parsed.readme;
    connections.push(...parsed.connections);
    evidence.push({
      source: "readme",
      path: readme.path,
      summary: `Parsed README (${readme.tools.length} tools, ${readme.installCommands.length} install snippets)`,
    });
  }

  const sourceTools = await parseSourceTools(source.workDir);
  const sourceSignals = await parseSourceSignals(source.workDir);
  const entrypointSignals = await parseEntrypointSignals(source.workDir);
  if (sourceTools.length > 0) {
    evidence.push({
      source: "source",
      summary: `Parsed ${sourceTools.length} tool definitions from source code`,
    });
  }

  const packageHints = await parsePackageHints(source.workDir);
  if (packageHints.length > 0) {
    evidence.push({
      source: "package",
      summary: `Found ${packageHints.length} package metadata files`,
    });
  }

  const mcpAssessment = assessMcpRepository({
    connections,
    entrypointSignals,
    packageHints,
    readme,
    serverJson,
    source,
    sourceSignals,
    sourceTools,
  });
  if (!mcpAssessment.isMcp) {
    warnings.push("Repository rejected as non-MCP: insufficient MCP evidence");
  }

  return {
    connections,
    evidence,
    mcpAssessment,
    packageHints,
    readme,
    serverJson,
    source,
    sourceTools,
    warnings,
  };
}
