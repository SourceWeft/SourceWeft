import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from "./fake-openai-sse-server";
import { recordRun, toGolden } from "./stream-characterization-harness";
import {
  GOLDEN_ENTRIES,
  GOLDEN_SCENARIOS,
} from "./stream-characterization-scenarios";

/**
 * Golden event sequences of the LangChain facade the agent runtime drives
 * (`createLangChainChatModel` → DeepSeek adapter → fake OpenAI-compatible SSE
 * server). The fixture was recorded on the code *before* the stream guards
 * landed; every entry must stay byte-identical afterwards: callback order and
 * chunk payloads (content, `additional_kwargs.reasoning_content`,
 * tool_call_chunks), the final message (content, tool_calls, usage_metadata,
 * response_metadata.finish_reason) and the generation observation.
 */
const golden = JSON.parse(
  readFileSync(
    new URL("./fixtures/stream-golden.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

let server: FakeOpenAIServer;
before(async () => {
  server = await startFakeOpenAIServer({ kind: "hang" });
});
after(async () => {
  await server.close();
});

for (const item of GOLDEN_SCENARIOS) {
  for (const { key, entry, handlerShape } of GOLDEN_ENTRIES) {
    test(`golden sequence: ${item.name} via model.${key}`, async () => {
      server.setScenario(item.scenario);
      const run = await recordRun({
        baseUrl: server.url,
        entry,
        handlerShape,
        requests: server.requests,
        timeoutMs: item.timeoutMs,
        // The agent runtime always passes a caller signal.
        signal: new AbortController().signal,
        tools: item.tools,
        thinking: item.thinking,
      });
      // JSON round-trip: the fixture cannot carry `undefined` members.
      assert.deepEqual(
        JSON.parse(JSON.stringify(toGolden(run))),
        golden[`${item.name}/${key}`],
      );
    });
  }
}

test("golden fixture covers every scenario and entry point", () => {
  const expected = GOLDEN_SCENARIOS.flatMap((item) =>
    GOLDEN_ENTRIES.map(({ key }) => `${item.name}/${key}`),
  );
  assert.deepEqual(Object.keys(golden).sort(), expected.sort());
});
