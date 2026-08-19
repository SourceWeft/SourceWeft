import "dotenv/config";

/**
 * OrcaRouter live smoke test — exercises the four modalities we integrate
 * (chat + reasoning_effort, embeddings, image, tts) against the real gateway
 * and surfaces the per-request `usage.cost` we bill on.
 *
 * Usage:
 *   ORCAROUTER_API_KEY=sk-orca-... pnpm --filter @sourceweft/backend exec \
 *     tsx src/scripts/test-orcarouter.ts [chat|embeddings|image|tts|all]
 *
 * Defaults to the cheap checks (chat + embeddings). `image` and `tts` cost
 * money, so they only run when named explicitly (or via `all`).
 */

type JsonRecord = Record<string, unknown>;

const apiKey = process.env.ORCAROUTER_API_KEY;
const baseUrl = (process.env.ORCAROUTER_API_BASE ?? "https://api.orcarouter.ai/v1").replace(/\/+$/, "");
const chatModel = process.env.ORCAROUTER_CHAT_MODEL ?? "anthropic/claude-opus-4.6";
const embedModel = process.env.ORCAROUTER_EMBED_MODEL ?? "openai/text-embedding-3-small";
const imageModel = process.env.ORCAROUTER_IMAGE_MODEL ?? "openai/gpt-image-1";
const ttsModel = process.env.ORCAROUTER_TTS_MODEL ?? "openai/tts-1";

const arg = (process.argv[2] ?? "default").toLowerCase();
const checks =
  arg === "all"
    ? ["chat", "embeddings", "image", "tts"]
    : arg === "default"
      ? ["chat", "embeddings"]
      : [arg];

if (!apiKey) {
  console.error("Missing ORCAROUTER_API_KEY.");
  process.exit(1);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function logUsage(label: string, body: JsonRecord) {
  const usage = asRecord(body.usage);
  if (!usage) {
    console.log(`${label}.usage`, "(none)");
    return;
  }
  const details = asRecord(usage.completion_tokens_details);
  console.log(`${label}.usage`, {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    reasoning_tokens: details?.reasoning_tokens,
    cost: usage.cost,
    cost_details: usage.cost_details,
  });
  if (usage.cost === undefined) {
    console.warn(
      `${label}: no usage.cost on the response — enable per-request cost so runtime billing has a real number.`,
    );
  }
}

async function postJson(path: string, payload: JsonRecord) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let json: JsonRecord = {};
  try {
    json = JSON.parse(text) as JsonRecord;
  } catch {
    json = { raw: text };
  }
  return { ok: response.ok, status: response.status, json };
}

async function checkChat() {
  console.log(`\n=== chat + reasoning_effort (${chatModel}) ===`);
  const { ok, status, json } = await postJson("/chat/completions", {
    model: chatModel,
    messages: [{ role: "user", content: "Which is bigger, 9.11 or 9.9? Answer briefly." }],
    reasoning_effort: "high",
  });
  console.log("status", status);
  if (!ok) {
    console.error("chat failed", json);
    return false;
  }
  const choice = asRecord((json.choices as unknown[])?.[0]);
  const message = asRecord(choice?.message);
  console.log("content", typeof message?.content === "string" ? message.content.slice(0, 200) : message?.content);
  if (typeof message?.reasoning_content === "string") {
    console.log("reasoning_content.length", message.reasoning_content.length);
  }
  logUsage("chat", json);
  return true;
}

async function checkEmbeddings() {
  console.log(`\n=== embeddings (${embedModel}) ===`);
  const { ok, status, json } = await postJson("/embeddings", {
    model: embedModel,
    input: "SourceWeft embeds this sentence.",
  });
  console.log("status", status);
  if (!ok) {
    console.error("embeddings failed", json);
    return false;
  }
  const first = asRecord((json.data as unknown[])?.[0]);
  const vector = Array.isArray(first?.embedding) ? first.embedding : [];
  console.log("embedding.dims", vector.length);
  logUsage("embeddings", json);
  return vector.length > 0;
}

async function checkImage() {
  console.log(`\n=== image generation (${imageModel}) ===`);
  const { ok, status, json } = await postJson("/images/generations", {
    model: imageModel,
    prompt: "A minimalist logo of an orca, flat vector, single color.",
    n: 1,
    size: "1024x1024",
  });
  console.log("status", status);
  if (!ok) {
    console.error("image failed", json);
    return false;
  }
  const first = asRecord((json.data as unknown[])?.[0]);
  console.log("image", {
    hasUrl: typeof first?.url === "string",
    hasB64: typeof first?.b64_json === "string",
  });
  logUsage("image", json);
  return true;
}

async function checkTts() {
  console.log(`\n=== tts (${ttsModel}) ===`);
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ttsModel,
      input: "Hello from SourceWeft.",
      voice: "alloy",
      response_format: "mp3",
    }),
  });
  console.log("status", response.status, "content-type", response.headers.get("content-type"));
  if (!response.ok) {
    console.error("tts failed", await response.text());
    return false;
  }
  const bytes = await response.arrayBuffer();
  console.log("audio.bytes", bytes.byteLength);
  return bytes.byteLength > 0;
}

const runners: Record<string, () => Promise<boolean>> = {
  chat: checkChat,
  embeddings: checkEmbeddings,
  image: checkImage,
  tts: checkTts,
};

console.log("baseUrl", baseUrl);
console.log("checks", checks.join(", "));

const results: Array<{ check: string; ok: boolean }> = [];
for (const check of checks) {
  const runner = runners[check];
  if (!runner) {
    console.error(`Unknown check: ${check} (expected chat|embeddings|image|tts|all)`);
    continue;
  }
  try {
    results.push({ check, ok: await runner() });
  } catch (error) {
    console.error(`${check} threw`, error instanceof Error ? error.message : error);
    results.push({ check, ok: false });
  }
}

console.log("\n=== summary ===");
console.table(results);
process.exit(results.every((r) => r.ok) ? 0 : 1);
