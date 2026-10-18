import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import type { AddressInfo } from "node:net";

/** One scripted `chat.completion.chunk` delta. */
export type FakeStreamChunk = {
  reasoning?: string;
  content?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    args?: string;
  }>;
  finishReason?: string | null;
  /** Overrides the scenario's `chunkDelayMs` for this chunk. */
  delayMs?: number;
  /** Usage carried on this chunk (providers that report usage per chunk). */
  usage?: FakeUsage;
};

export type FakeUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
};

export type FakeScenario =
  | {
      kind: "stream";
      /** Delay before the response headers (and so the first byte) are sent. */
      firstTokenDelayMs?: number;
      /** Delay between consecutive chunks. */
      chunkDelayMs?: number;
      chunks: FakeStreamChunk[];
      /** Emitted as the trailing usage chunk when present. */
      usage?: FakeUsage;
      /** After the last chunk: end the body normally, destroy the socket, or hang. */
      ending?: "done" | "early-close" | "hang";
    }
  | {
      /** Accept the connection but never send any byte (no headers). */
      kind: "hang";
    }
  | {
      kind: "status";
      status: number;
      body?: unknown;
    };

export type FakeRequestRecord = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
};

export type FakeOpenAIServer = {
  /** OpenAI-compatible base URL (ends with `/v1`). */
  url: string;
  requests: FakeRequestRecord[];
  setScenario(scenario: FakeScenario): void;
  /** How many chunks (not counting usage) were written for each request. */
  written: number[];
  close(): Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * In-process OpenAI-compatible SSE server. Every request answers with the
 * current scenario; a scenario can delay the first byte, pace chunks, emit
 * reasoning/content/tool-call deltas, finish with usage, close early or hang.
 */
export async function startFakeOpenAIServer(
  initial: FakeScenario,
): Promise<FakeOpenAIServer> {
  let scenario = initial;
  const requests: FakeRequestRecord[] = [];
  const written: number[] = [];
  const sockets = new Set<Socket>();
  let closing = false;

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: req.url ?? "",
      headers: req.headers,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    const index = written.length;
    written.push(0);
    const current = scenario;

    if (current.kind === "hang") {
      // Never respond; the socket is destroyed on close().
      return;
    }
    if (current.kind === "status") {
      res.writeHead(current.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          current.body ?? {
            error: { message: `fake upstream status ${current.status}` },
          },
        ),
      );
      return;
    }

    if (current.firstTokenDelayMs) await sleep(current.firstTokenDelayMs);
    if (closing || res.destroyed) return;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders();

    const id = `chatcmpl-fake-${index}`;
    const model = (current as { model?: string }).model ?? "fake-model";
    const emit = (payload: unknown) =>
      res.write(`data: ${JSON.stringify(payload)}\n\n`);

    let first = true;
    for (const chunk of current.chunks) {
      const delay = chunk.delayMs ?? (first ? 0 : current.chunkDelayMs);
      first = false;
      if (delay) await sleep(delay);
      if (closing || res.destroyed) return;
      const delta: Record<string, unknown> = { role: "assistant" };
      if (chunk.reasoning !== undefined)
        delta.reasoning_content = chunk.reasoning;
      delta.content =
        chunk.content ?? (chunk.reasoning !== undefined ? null : "");
      if (chunk.toolCalls) {
        delta.tool_calls = chunk.toolCalls.map((call) => ({
          index: call.index,
          ...(call.id !== undefined ? { id: call.id, type: "function" } : {}),
          function: {
            ...(call.name !== undefined ? { name: call.name } : {}),
            arguments: call.args ?? "",
          },
        }));
      }
      emit({
        id,
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: chunk.finishReason ?? null,
          },
        ],
        ...(chunk.usage ? { usage: chunk.usage } : {}),
      });
      written[index] = (written[index] ?? 0) + 1;
    }

    const ending = current.ending ?? "done";
    if (ending === "hang") return;
    if (ending === "early-close") {
      res.socket?.destroy();
      return;
    }
    if (current.usage) {
      emit({
        id,
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [],
        usage: current.usage,
      });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    written,
    setScenario: (next) => {
      scenario = next;
    },
    close: async () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
