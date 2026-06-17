import { ChatOpenAI } from "@langchain/openai";
import "dotenv/config";
import { extractReasoningFromMessageChunk } from "../modules/threads";

type JsonRecord = Record<string, unknown>;
type TestMode =
  | "auto"
  | "off"
  | "off-exclude"
  | "off-legacy"
  | "off-none-legacy"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const VALID_MODES = [
  "auto",
  "off",
  "off-exclude",
  "off-legacy",
  "off-none-legacy",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
const USAGE = "Usage: OPENROUTER_API_KEY=... pnpm --filter @sourceweft/backend exec tsx src/scripts/test-openrouter-reasoning.ts [model] [auto|off|off-exclude|off-legacy|off-none-legacy|minimal|low|medium|high|xhigh|all] [prompt]";

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.argv[2] ?? process.env.OPENROUTER_TEST_MODEL ?? "openai/gpt-5.5";
const modeArg = process.argv[3] ?? "xhigh";
const modesToRun: TestMode[] = modeArg === "all"
  ? ["auto", "off", "minimal", "low", "medium", "high", "xhigh"]
  : VALID_MODES.includes(modeArg as TestMode)
    ? [modeArg as TestMode]
    : [];
const prompt = process.argv.slice(4).join(" ").trim() ||
  "Which is bigger, 9.11 or 9.9? Think carefully, then answer briefly.";

if (!apiKey) {
  console.error("Missing OPENROUTER_API_KEY.");
  console.error(USAGE);
  process.exit(1);
}

if (modesToRun.length === 0) {
  console.error(`Invalid mode: ${modeArg}`);
  console.error(USAGE);
  process.exit(1);
}

function resolveMode(modeValue: TestMode) {
  return modeValue === "auto" || modeValue.startsWith("off")
    ? modeValue
    : "effort";
}

function resolveEffort(modeValue: TestMode) {
  return resolveMode(modeValue) === "effort" ? modeValue : "xhigh";
}

function buildReasoningPayload(modeValue: TestMode) {
  const mode = resolveMode(modeValue);
  if (mode === "auto") {
    return {};
  }
  if (mode === "off") {
    return {
      reasoning: {
        exclude: true,
      },
    };
  }
  if (mode === "off-exclude") {
    return {
      reasoning: {
        exclude: true,
      },
    };
  }
  if (mode === "off-legacy") {
    return {
      include_reasoning: false,
    };
  }
  if (mode === "off-none-legacy") {
    return {
      include_reasoning: false,
      reasoning: {
        effort: "none",
        exclude: true,
      },
    };
  }
  return {
    include_reasoning: true,
    reasoning: {
      enabled: true,
      effort: resolveEffort(modeValue),
      exclude: false,
    },
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function preview(value: string, max = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function textFromReasoningDetails(value: unknown) {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      const detail = asRecord(item);
      if (!detail) {
        return "";
      }
      if (typeof detail.text === "string") {
        return detail.text;
      }
      if (typeof detail.summary === "string") {
        return detail.summary;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

type ReasoningRunResult = {
  contentBlockReasoningLength?: number;
  error?: string;
  reasoningDetailChunks: number;
  reasoningLength: number;
  reasoningStringChunks: number;
  sourceweftExtractedReasoningLength?: number;
  textLength: number;
};

function emptyResult(error?: string): ReasoningRunResult {
  return {
    error,
    reasoningDetailChunks: 0,
    reasoningLength: 0,
    reasoningStringChunks: 0,
    textLength: 0,
  };
}

async function testOpenRouterFetch(modeValue: TestMode): Promise<ReasoningRunResult> {
  console.log("\n=== Direct OpenRouter fetch stream ===");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://sourceweft.com",
      "X-OpenRouter-Title": "SourceWeft Reasoning Test",
      "X-Title": "SourceWeft Reasoning Test",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      ...buildReasoningPayload(modeValue),
      stream: true,
    }),
  });

  console.log("status", response.status, response.statusText);
  console.log("x-generation-id", response.headers.get("x-generation-id"));

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    console.log(errorText);
    return emptyResult(errorText);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let reasoningDetailChunks = 0;
  let reasoningStringChunks = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        break;
      }

      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data: ")) {
        continue;
      }

      const data = line.slice(6);
      if (data === "[DONE]") {
        break;
      }

      const parsed = JSON.parse(data) as JsonRecord;
      const choice = asRecord((parsed.choices as unknown[])?.[0]);
      const delta = asRecord(choice?.delta);
      if (!delta) {
        continue;
      }

      if (typeof delta.content === "string") {
        text += delta.content;
      }

      if (typeof delta.reasoning === "string") {
        reasoningStringChunks += 1;
        reasoning += delta.reasoning;
        continue;
      }

      const detailsText = textFromReasoningDetails(delta.reasoning_details);
      if (detailsText) {
        reasoningDetailChunks += 1;
        reasoning += detailsText;
      }
    }
  }

  console.log("direct.text.length", text.length, preview(text));
  console.log("direct.reasoning.length", reasoning.length, preview(reasoning));
  console.log("direct.reasoningStringChunks", reasoningStringChunks);
  console.log("direct.reasoningDetailChunks", reasoningDetailChunks);
  return {
    reasoningDetailChunks,
    reasoningLength: reasoning.length,
    reasoningStringChunks,
    textLength: text.length,
  };
}

async function testLangChainStream(modeValue: TestMode): Promise<ReasoningRunResult> {
  console.log("\n=== LangChain ChatOpenAI stream ===");
  const llm = new ChatOpenAI({
    model,
    apiKey,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://sourceweft.com",
        "X-OpenRouter-Title": "SourceWeft Reasoning Test",
        "X-Title": "SourceWeft Reasoning Test",
      },
    },
    modelKwargs: buildReasoningPayload(modeValue),
    __includeRawResponse: true,
    streaming: true,
  });

  let stream;
  try {
    stream = await llm.stream(prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("langchain.error", message);
    return emptyResult(message);
  }
  let text = "";
  let contentBlockReasoning = "";
  let rawReasoning = "";
  let sourceweftExtractedReasoning = "";
  let chunks = 0;
  let rawChunksWithReasoning = 0;
  let rawChunksWithReasoningDetails = 0;

  for await (const chunk of stream) {
    chunks += 1;
    text += chunk.text;

    for (const block of chunk.contentBlocks ?? []) {
      if (block.type === "reasoning" && typeof block.reasoning === "string") {
        contentBlockReasoning += block.reasoning;
      }
    }

    const additionalKwargs = asRecord(chunk.additional_kwargs);
    const extracted = extractReasoningFromMessageChunk(chunk);
    if (extracted) {
      sourceweftExtractedReasoning += extracted;
    }

    const raw = asRecord(additionalKwargs?.__raw_response);
    const choice = asRecord((raw?.choices as unknown[])?.[0]);
    const delta = asRecord(choice?.delta);
    if (!delta) {
      continue;
    }

    if (typeof delta.reasoning === "string") {
      rawChunksWithReasoning += 1;
      rawReasoning += delta.reasoning;
      continue;
    }

    const detailsText = textFromReasoningDetails(delta.reasoning_details);
    if (detailsText) {
      rawChunksWithReasoningDetails += 1;
      rawReasoning += detailsText;
    }
  }

  console.log("langchain.chunks", chunks);
  console.log("langchain.text.length", text.length, preview(text));
  console.log(
    "langchain.contentBlocks.reasoning.length",
    contentBlockReasoning.length,
    preview(contentBlockReasoning),
  );
  console.log("langchain.raw.reasoning.length", rawReasoning.length, preview(rawReasoning));
  console.log(
    "sourceweft.extractReasoningFromMessageChunk.length",
    sourceweftExtractedReasoning.length,
    preview(sourceweftExtractedReasoning),
  );
  console.log("langchain.rawChunksWithReasoning", rawChunksWithReasoning);
  console.log("langchain.rawChunksWithReasoningDetails", rawChunksWithReasoningDetails);
  return {
    contentBlockReasoningLength: contentBlockReasoning.length,
    reasoningDetailChunks: rawChunksWithReasoningDetails,
    reasoningLength: rawReasoning.length,
    reasoningStringChunks: rawChunksWithReasoning,
    sourceweftExtractedReasoningLength: sourceweftExtractedReasoning.length,
    textLength: text.length,
  };
}

console.log("model", model);
console.log("prompt", prompt);
const summary: Array<{
  direct: ReasoningRunResult;
  langchain: ReasoningRunResult;
  mode: string;
}> = [];

for (const currentMode of modesToRun) {
  console.log("\n############################################################");
  console.log("mode", currentMode);
  console.log("payload", JSON.stringify(buildReasoningPayload(currentMode)));
  const direct = await testOpenRouterFetch(currentMode);
  const langchain = await testLangChainStream(currentMode);
  summary.push({ mode: currentMode, direct, langchain });
}

if (summary.length > 1) {
  console.log("\n=== Summary ===");
  console.table(
    summary.map((entry) => ({
      mode: entry.mode,
      directReasoning: entry.direct.reasoningLength,
      directText: entry.direct.textLength,
      langchainRawReasoning: entry.langchain.reasoningLength,
      sourceweftExtracted:
        entry.langchain.sourceweftExtractedReasoningLength ?? 0,
      langchainText: entry.langchain.textLength,
      directError: entry.direct.error ? "yes" : "",
      langchainError: entry.langchain.error ? "yes" : "",
    })),
  );
}
