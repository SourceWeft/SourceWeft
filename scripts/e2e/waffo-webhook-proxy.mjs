import http from "node:http";

const upstream = new URL(
  process.env.WAFFO_E2E_API_URL || "http://127.0.0.1:3541",
);
if (!["127.0.0.1", "localhost"].includes(upstream.hostname))
  throw new Error("Webhook proxy must target a local test API");
const port = Number(process.env.WAFFO_E2E_PROXY_PORT || 3543);
const route = "/v1/billing/webhooks/waffo";
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== route) {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 256 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const result = await fetch(new URL(route, upstream), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-waffo-signature": String(request.headers["x-waffo-signature"] || ""),
      },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(15_000),
    });
    response
      .writeHead(result.status, { "content-type": "text/plain" })
      .end(await result.text());
  } catch {
    response.writeHead(502).end("Test API unavailable");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Waffo test webhook proxy: http://127.0.0.1:${port}${route}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close());
