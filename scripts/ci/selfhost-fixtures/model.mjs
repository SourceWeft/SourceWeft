// Explicit test-only OpenAI-compatible provider. Never used in shipped Compose.
import { createServer } from "node:http";
createServer(async (req, res) => {
  const chunks = [];
  for await (const part of req) chunks.push(part);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.url.endsWith("/embeddings")) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const vector = Array.from({ length: body.dimensions ?? 1024 }, (_, i) =>
      i === 0 ? 1 : 0,
    );
    const bytes = Buffer.alloc(vector.length * 4);
    vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    const embedding =
      body.encoding_format === "base64" ? bytes.toString("base64") : vector;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        object: "list",
        model: body.model,
        data: inputs.map((_, index) => ({
          object: "embedding",
          index,
          embedding,
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
  }
  if (req.url.endsWith("/models"))
    return res.end(
      JSON.stringify({ data: [{ id: "selfhost-test", object: "model" }] }),
    );
  const answer = body.response_format
    ? JSON.stringify({ title: "Selfhost acceptance" })
    : "SELFHOST_TEST_OK";
  if (!body.stream) {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        id: "test-completion",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: answer },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  const send = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: "test-completion",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  send({ role: "assistant", content: "" });
  if (JSON.stringify(body.messages).includes("SLOW_SELFHOST")) {
    let ticks = 0;
    const timer = setInterval(() => {
      send({ content: "working " });
      if (++ticks === 100) {
        clearInterval(timer);
        send({}, "stop");
        res.end("data: [DONE]\n\n");
      }
    }, 100);
    res.on("close", () => clearInterval(timer));
  } else {
    send({ content: answer });
    send({}, "stop");
    res.end("data: [DONE]\n\n");
  }
}).listen(8787, "0.0.0.0");
