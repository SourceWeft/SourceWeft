import { spawn } from "node:child_process";
import type {
  ConnectionCandidate,
  ParsedTool,
  RuntimeIntrospectionResult,
  StaticParseResult,
} from "../types";

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

function chooseDockerCandidate(connections: ConnectionCandidate[]) {
  return connections.find((candidate) => {
    if (candidate.transport !== "stdio") {
      return false;
    }
    if (candidate.authRequired || (candidate.requiredSecrets ?? []).length > 0) {
      return false;
    }
    return Boolean(candidate.dockerImage || candidate.registryType === "oci");
  });
}

function dockerImageFor(candidate: ConnectionCandidate) {
  return candidate.dockerImage ?? candidate.identifier;
}

/**
 * Image names reaching this function are scraped from untrusted README shell
 * snippets, so we never `docker run` an arbitrary one. Only images whose name
 * begins with an operator-configured registry/namespace prefix are allowed.
 * The allowlist defaults to empty, which disables runtime introspection.
 */
function introspectImageAllowlist() {
  return (process.env.MCP_INTROSPECT_IMAGE_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isAllowedDockerImage(image: string) {
  const allowlist = introspectImageAllowlist();
  if (allowlist.length === 0) {
    return false;
  }
  return allowlist.some((prefix) => image.startsWith(prefix));
}

async function dockerAvailable() {
  return new Promise<boolean>((resolve) => {
    const child = spawn("docker", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function dockerImageAvailable(image: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn("docker", ["image", "inspect", image], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function frameMessage(message: unknown) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

class McpFrameParser {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];
    while (this.#buffer.length > 0) {
      const separator = this.#buffer.indexOf("\r\n\r\n");
      if (separator === -1) {
        break;
      }
      const header = this.#buffer.slice(0, separator).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch?.[1]) {
        this.#buffer = this.#buffer.slice(separator + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = separator + 4;
      const bodyEnd = bodyStart + length;
      if (this.#buffer.length < bodyEnd) {
        break;
      }
      const body = this.#buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.#buffer = this.#buffer.slice(bodyEnd);
      try {
        messages.push(JSON.parse(body));
      } catch {
        // Ignore malformed frames and keep parsing later frames.
      }
    }
    return messages;
  }
}

function toRuntimeTool(raw: unknown): ParsedTool | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const tool = raw as Record<string, unknown>;
  if (typeof tool.name !== "string") {
    return undefined;
  }
  return {
    name: tool.name,
    title: typeof tool.title === "string" ? tool.title : undefined,
    description:
      typeof tool.description === "string" ? tool.description : undefined,
    inputSchema:
      tool.inputSchema && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : {},
    outputSchema:
      tool.outputSchema && typeof tool.outputSchema === "object"
        ? (tool.outputSchema as Record<string, unknown>)
        : undefined,
    annotations:
      tool.annotations && typeof tool.annotations === "object"
        ? (tool.annotations as Record<string, unknown>)
        : {},
    risk: "unknown",
    confidence: 0.98,
    source: "runtime",
  };
}

export async function introspectRuntime(
  parsed: StaticParseResult,
): Promise<RuntimeIntrospectionResult> {
  const candidate = chooseDockerCandidate(parsed.connections);
  if (!candidate) {
    return {
      evidence: [],
      skippedReason: "No unauthenticated Docker/OCI stdio candidate was found",
      tools: [],
      warnings: [],
    };
  }
  const image = dockerImageFor(candidate);
  if (!image) {
    return {
      evidence: [],
      skippedReason: "Docker candidate did not include an image identifier",
      tools: [],
      warnings: [],
    };
  }
  if (!isAllowedDockerImage(image)) {
    return {
      evidence: [],
      skippedReason: `Docker image is not on the introspection allowlist: ${image}`,
      tools: [],
      warnings: [],
    };
  }
  if (!(await dockerAvailable())) {
    return {
      evidence: [],
      skippedReason: "Docker is not available",
      tools: [],
      warnings: [],
    };
  }
  if (!(await dockerImageAvailable(image))) {
    return {
      evidence: [],
      skippedReason: `Docker image is not available locally: ${image}`,
      tools: [],
      warnings: [],
    };
  }

  return new Promise<RuntimeIntrospectionResult>((resolve) => {
    const warnings: string[] = [];
    const pending = new Map<number, PendingRequest>();
    const parser = new McpFrameParser();
    let nextId = 1;
    let stderr = "";
    let resolved = false;

    const child = spawn("docker", ["run", "--rm", "-i", "--network", "none", image], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    function finish(result: RuntimeIntrospectionResult) {
      if (resolved) {
        return;
      }
      resolved = true;
      for (const request of pending.values()) {
        request.reject(new Error("Runtime introspection finished"));
      }
      pending.clear();
      child.kill("SIGTERM");
      resolve(result);
    }

    const timeout = setTimeout(() => {
      finish({
        evidence: [],
        skippedReason: "Runtime introspection timed out after 30s",
        tools: [],
        warnings: stderr ? [`stderr: ${stderr.slice(0, 1_000)}`] : [],
      });
    }, 30_000);

    function request(method: string, params: Record<string, unknown> = {}) {
      const id = nextId;
      nextId += 1;
      const payload = { jsonrpc: "2.0", id, method, params };
      child.stdin.write(frameMessage(payload));
      return new Promise<unknown>((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      });
    }

    function notify(method: string, params: Record<string, unknown> = {}) {
      child.stdin.write(frameMessage({ jsonrpc: "2.0", method, params }));
    }

    child.stdout.on("data", (chunk: Buffer) => {
      for (const message of parser.push(chunk)) {
        if (!message || typeof message !== "object") {
          continue;
        }
        const response = message as Record<string, unknown>;
        if (typeof response.id !== "number") {
          continue;
        }
        const request = pending.get(response.id);
        if (!request) {
          continue;
        }
        pending.delete(response.id);
        if (response.error) {
          request.reject(new Error(JSON.stringify(response.error)));
        } else {
          request.resolve(response.result);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4_000) {
        stderr = stderr.slice(-4_000);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      finish({
        evidence: [],
        skippedReason: `Failed to start Docker introspection: ${error.message}`,
        tools: [],
        warnings,
      });
    });

    child.on("close", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        finish({
          evidence: [],
          skippedReason: `Runtime process exited before completion with code ${code}`,
          tools: [],
          warnings: stderr ? [`stderr: ${stderr.slice(0, 1_000)}`] : [],
        });
      }
    });

    void (async () => {
      try {
        await request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "sourceweft-mcp-ingest", version: "0.1.0" },
        });
        notify("notifications/initialized");
        const toolsResult = (await request("tools/list")) as
          | { tools?: unknown[] }
          | undefined;
        const tools = (toolsResult?.tools ?? [])
          .map(toRuntimeTool)
          .filter((tool): tool is ParsedTool => Boolean(tool));
        clearTimeout(timeout);
        finish({
          evidence: [
            {
              source: "runtime",
              summary: `Introspected ${tools.length} tools using Docker image ${image}`,
            },
          ],
          tools,
          warnings,
        });
      } catch (error) {
        clearTimeout(timeout);
        finish({
          evidence: [],
          skippedReason: `Runtime introspection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          tools: [],
          warnings: stderr ? [`stderr: ${stderr.slice(0, 1_000)}`] : warnings,
        });
      }
    })();
  });
}
