import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkSourceContent } from "../src/index";
import {
  SIMPLIFIED_ONLY,
  TRADITIONAL_ONLY,
  documentLanguage,
  labelChunkLanguages,
} from "../src/chunk-language";

const SIMPLIFIED =
  "我们认为这个国家的经济发展还会继续，学者们说现在的问题是开放与改革之间的关系。";
const TRADITIONAL =
  "我們認為這個國家的經濟發展還會繼續，學者們說現在的問題是開放與改革之間的關係。";
const JAPANESE =
  "私たちはこの国の経済発展が続くと考えています。研究者によれば、現在の問題は開放と改革の関係です。";
const KOREAN =
  "우리는 이 나라의 경제 발전이 계속될 것이라고 생각합니다. 연구자들은 현재의 문제가 개방과 개혁의 관계라고 말합니다.";
const ENGLISH =
  "The committee reviewed the proposal in detail and agreed that the new policy should take effect next spring.";
const SPANISH =
  "El comité revisó la propuesta en detalle y acordó que la nueva política debería entrar en vigor la próxima primavera.";
const RUSSIAN =
  "Комитет подробно рассмотрел предложение и согласился, что новая политика должна вступить в силу следующей весной.";

test("the simplified and traditional tables are paired and disjoint", () => {
  assert.equal([...SIMPLIFIED_ONLY].length, [...TRADITIONAL_ONLY].length);
  for (const char of SIMPLIFIED_ONLY) {
    assert.equal(TRADITIONAL_ONLY.includes(char), false, char);
  }
});

test("CJK chunks are labelled by script, Chinese by its character set", async () => {
  assert.deepEqual(
    await labelChunkLanguages([SIMPLIFIED, TRADITIONAL, JAPANESE, KOREAN]),
    ["zh-CN", "zh-TW", "ja", "ko"],
  );
});

test("other scripts are labelled by the detector", async () => {
  assert.deepEqual(await labelChunkLanguages([ENGLISH, SPANISH, RUSSIAN]), [
    "en",
    "es",
    "ru",
  ]);
});

test("Chinese text keeps its label when it quotes English names, code and links", async () => {
  const text = `${SIMPLIFIED}使用 React 的 useState 钩子管理状态，详见 https://react.dev/reference/react/useState 和 \`const [count, setCount] = useState(0)\`。`;
  assert.deepEqual(await labelChunkLanguages([text]), ["zh-CN"]);
});

test("code, links and markup are not read as language", async () => {
  const text = [
    SIMPLIFIED,
    "```ts",
    "export function createServer(options: ServerOptions): Server { return new Server(options); }",
    "export function closeServer(server: Server): Promise<void> { return server.close(); }",
    "```",
    "[documentation](https://example.com/docs/getting-started/installation-and-configuration)",
  ].join("\n");
  assert.deepEqual(await labelChunkLanguages([text]), ["zh-CN"]);
});

test("short or letterless chunks take the document's majority", async () => {
  assert.deepEqual(
    await labelChunkLanguages([SIMPLIFIED, "OK", "1, 2, 3", SIMPLIFIED, SIMPLIFIED]),
    ["zh-CN", "zh-CN", "zh-CN", "zh-CN", "zh-CN"],
  );
});

test("without a clear majority, short chunks stay unlabelled", async () => {
  assert.deepEqual(await labelChunkLanguages([ENGLISH, SPANISH, "OK"]), [
    "en",
    "es",
    null,
  ]);
  assert.deepEqual(await labelChunkLanguages(["OK", "Thanks!"]), [null, null]);
});

test("a document's language is the one most of its labelled text is in", () => {
  assert.equal(
    documentLanguage([
      { text: SIMPLIFIED, language: "zh-CN" },
      { text: SIMPLIFIED, language: "zh-CN" },
      { text: "short", language: "en" },
    ]),
    "zh-CN",
  );
  assert.equal(
    documentLanguage([
      { text: SIMPLIFIED, language: "zh-CN" },
      { text: ENGLISH.repeat(2), language: "en" },
    ]),
    null,
  );
  assert.equal(documentLanguage([{ text: "x", language: null }]), null);
});

test("chunks of a document record their language", async () => {
  const content = `# 民法典\n\n${SIMPLIFIED.repeat(20)}\n\n## 附录\n\n${SIMPLIFIED.repeat(20)}`;
  const chunks = await chunkSourceContent(content, { chunkSize: 400 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.equal(chunk.language, "zh-CN");
});

test("chunks without a detectable language have no language field", async () => {
  const chunks = await chunkSourceContent("12345");
  assert.equal(chunks.length, 1);
  assert.equal("language" in chunks[0]!, false);
});
