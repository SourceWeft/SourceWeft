import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
// Manual smoke probe against an operator-supplied key; intentionally unbilled
// (see the matching exemption in shared/model-gateway/architecture.test.ts).
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- see above
import { createModelGateway } from "@sourceweft/model-gateway";
import sharp from "sharp";
import { resolveCapabilityWebProvider } from "../modules/capabilities/host-services";
import { createDeepSeekOcrProvider } from "../modules/sources/parsers/providers/deepseek-ocr-provider";
import { ffmpegAsrAudioPreparer } from "../shared/asr-audio-preparer";
import { probeAudioDurationSeconds } from "../shared/audio-duration";
import { ffmpegTtsAudioTranscoder } from "../shared/tts-audio-transcoder";

/**
 * Live smoke test for the DeepSeek application APIs (#482): web search and
 * fetch, OCR, TTS and ASR. It calls DeepSeek with DEEPSEEK_API_KEY through the
 * same code the product uses, so it costs a few cents and needs ffmpeg on PATH
 * for the TTS conversion and ASR steps.
 *
 *   pnpm --filter @sourceweft/backend exec tsx src/scripts/smoke-deepseek-app-apis.ts
 *
 * Options:
 *   --only web,ocr,tts,asr   run a subset (default: all)
 *   --pdf <path>             also OCR this PDF (e.g. a scanned document)
 *   --audio <path>           transcribe this file instead of synthesized speech
 *   --out <dir>              where to save audio (default: a temp directory)
 */
const STEPS = ["web", "ocr", "tts", "asr"] as const;
type Step = (typeof STEPS)[number];

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) {
  throw new Error("Missing DEEPSEEK_API_KEY");
}
const baseUrl = (
  process.env.DEEPSEEK_API_BASE?.trim() || "https://api.deepseek.com"
).replace(/\/+$/, "");
const only = option("only")
  ?.split(",")
  .map((item) => item.trim().toLowerCase());
const unknown = only?.filter((item) => !STEPS.includes(item as Step)) ?? [];
if (unknown.length > 0) {
  throw new Error(
    `Unknown step(s): ${unknown.join(", ")}. Use ${STEPS.join(", ")}`,
  );
}
const selected = new Set<Step>((only as Step[] | undefined) ?? STEPS);
const outDir = option("out") ?? join(tmpdir(), "sourceweft-deepseek-smoke");

const gateway = createModelGateway({
  asrAudioPreparer: ffmpegAsrAudioPreparer,
  ttsAudioTranscoder: ffmpegTtsAudioTranscoder,
  providers: { deepseek: { kind: "deepseek", baseUrl, apiKey } },
  modelRoutes: {
    tts: {
      strategy: "priority",
      targets: [{ provider: "deepseek", model: "deepseek-tts", priority: 1 }],
    },
    asr: {
      strategy: "priority",
      targets: [{ provider: "deepseek", model: "deepseek-asr", priority: 1 }],
    },
  },
  timeoutMs: 240_000,
  maxRetries: 1,
});

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function preview(text: string, length = 160) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

const magic = (bytes: Uint8Array, length = 4) =>
  String.fromCharCode(...bytes.subarray(0, length));

async function save(name: string, bytes: Uint8Array) {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, name);
  await writeFile(path, bytes);
  return path;
}

async function smokeWeb() {
  // The product's own seam: the web capability builds the provider from the
  // environment. Selecting DeepSeek here affects only this process.
  process.env.WEB_PROVIDER = "deepseek";
  const provider = await resolveCapabilityWebProvider();
  check(provider, "no web provider was resolved");
  check(
    provider.name === "deepseek",
    `expected the deepseek web provider, got ${provider.name}`,
  );
  const search = await provider.search({ query: "DeepSeek API", limit: 3 });
  check(search.count > 0, "search returned no results");
  console.log(
    `  search: ${search.count} results, first: ${search.results[0]?.url}`,
  );

  const fetched = await provider.fetch({
    items: [{ url: "https://example.com/" }],
  });
  const page = fetched.results[0];
  check(page && !page.error, `fetch failed: ${page?.error ?? "no result"}`);
  check(
    /example domain/i.test(page.markdown),
    "fetched page text is unexpected",
  );
  console.log(`  fetch: "${page.title}", ${page.markdown.length} chars`);
}

async function ocr(input: {
  fileName: string;
  mimeType: string;
  content: Buffer;
}) {
  const provider = createDeepSeekOcrProvider({
    apiKey: () => apiKey as string,
    baseUrl,
  });
  const outcome = await provider.start({
    sourceId: "smoke",
    teamId: "smoke",
    workspaceId: "smoke",
    userId: "smoke",
    fileName: input.fileName,
    mimeType: input.mimeType,
    fileSize: input.content.byteLength,
    content: input.content,
    config: { chunkSize: 512, parserVersion: "smoke" },
  });
  check(outcome.kind === "completed", `OCR did not complete: ${outcome.kind}`);
  const { metadata, content, pages } = outcome.document;
  console.log(
    `  ${input.fileName}: ${pages.length} page(s), pageCount=${String(metadata.pageCount)} (${String(metadata.pageCountSource)}), request ${String(metadata.providerRequestId)}`,
  );
  if (metadata.providerTruncatedPages) {
    console.log(
      `  truncated pages: ${JSON.stringify(metadata.providerTruncatedPages)}`,
    );
  }
  console.log(`  text: ${preview(content)}`);
  return content;
}

async function smokeOcr() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="260">
    <rect width="100%" height="100%" fill="white"/>
    <text x="40" y="100" font-family="Helvetica, Arial, sans-serif" font-size="56" fill="black">SourceWeft OCR smoke</text>
    <text x="40" y="190" font-family="Helvetica, Arial, sans-serif" font-size="56" fill="black">Invoice 20261114</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const text = await ocr({
    fileName: "smoke.png",
    mimeType: "image/png",
    content: png,
  });
  check(/sourceweft/i.test(text), "the image text was not recognized");
  check(
    text.includes("20261114"),
    "the digits in the image were not recognized",
  );

  const pdfPath = option("pdf");
  if (pdfPath) {
    const pdfText = await ocr({
      fileName: basename(pdfPath),
      mimeType: "application/pdf",
      content: await readFile(pdfPath),
    });
    check(pdfText.trim().length > 0, "the PDF produced no text");
  } else {
    console.log("  (no --pdf given; PDF path not exercised)");
  }
}

const SENTENCE =
  "这是 SourceWeft 的语音冒烟测试，我们用它来确认语音合成和语音识别都能正常工作。";

async function seconds(bytes: Uint8Array, mimeType: string) {
  return probeAudioDurationSeconds({ buffer: Buffer.from(bytes), mimeType });
}

async function smokeTts() {
  const wav = await gateway.tts.speech({ model: "tts", input: SENTENCE });
  const wavBytes = new Uint8Array(wav.audio);
  check(magic(wavBytes) === "RIFF", `expected WAV, got ${wav.mimeType}`);
  const wavSeconds = await seconds(wavBytes, "audio/wav");
  check(wavSeconds && wavSeconds > 1, "the WAV is not decodable speech");
  console.log(
    `  wav: ${wavBytes.byteLength} bytes, ${wavSeconds.toFixed(1)} s, billedUnits=${String(wav.raw.billedUnits)} -> ${await save("tts.wav", wavBytes)}`,
  );

  const mp3 = await gateway.tts.speech({
    model: "tts",
    input: SENTENCE,
    voice: "tide",
    responseFormat: "mp3",
  });
  const mp3Bytes = new Uint8Array(mp3.audio);
  check(mp3.raw.convertedFrom === "wav", "mp3 was not converted from wav");
  check(mp3.mimeType === "audio/mpeg", `unexpected mime type ${mp3.mimeType}`);
  const mp3Seconds = await seconds(mp3Bytes, "audio/mpeg");
  check(mp3Seconds && mp3Seconds > 1, "the converted mp3 is not decodable");
  console.log(
    `  mp3 (voice tide, converted): ${mp3Bytes.byteLength} bytes, ${mp3Seconds.toFixed(1)} s -> ${await save("tts.mp3", mp3Bytes)}`,
  );
}

async function smokeAsr() {
  const audioPath = option("audio");
  let audio: Uint8Array;
  let fileName: string;
  let expect: RegExp | undefined;
  if (audioPath) {
    audio = new Uint8Array(await readFile(audioPath));
    fileName = basename(audioPath);
  } else {
    // Long enough (over 120 s of speech) to force more than one chunk.
    const speech = await gateway.tts.speech({
      model: "tts",
      input: Array.from(
        { length: 22 },
        (_, index) => `第${index + 1}段。${SENTENCE}`,
      ).join(""),
    });
    audio = new Uint8Array(speech.audio);
    fileName = "asr-input.wav";
    expect = /冒烟测试/;
    console.log(`  synthesized input -> ${await save(fileName, audio)}`);
  }

  const startedAt = Date.now();
  const result = await gateway.asr.transcribe({
    model: "asr",
    audio,
    fileName,
    responseFormat: "verbose_json",
    timestampGranularities: ["segment"],
  });
  check(result.text.trim().length > 0, "the transcript is empty");
  if (expect) {
    check(
      expect.test(result.text),
      "the transcript does not contain the spoken phrase",
    );
  }
  const chunks = Number(result.raw.chunkCount ?? 1);
  console.log(
    `  ${fileName}: ${result.duration?.toFixed(1)} s of audio, ${chunks} chunk(s), ${result.segments?.length ?? 0} segment(s), ${((Date.now() - startedAt) / 1000).toFixed(1)} s wall`,
  );
  for (const segment of (result.segments ?? []).slice(0, 4)) {
    console.log(
      `  [${segment.start.toFixed(1)} - ${segment.end.toFixed(1)}] ${preview(segment.text, 70)}`,
    );
  }
  if (!audioPath) {
    check(
      chunks >= 2,
      `expected the long input to be split, got ${chunks} chunk`,
    );
  }
}

const runners: Record<Step, () => Promise<void>> = {
  web: smokeWeb,
  ocr: smokeOcr,
  tts: smokeTts,
  asr: smokeAsr,
};

const failed: Step[] = [];
for (const step of STEPS) {
  if (!selected.has(step)) continue;
  console.log(`\n== ${step}`);
  try {
    await runners[step]();
    console.log(`PASS ${step}`);
  } catch (error) {
    failed.push(step);
    console.log(
      `FAIL ${step}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

console.log(
  failed.length > 0
    ? `\n${failed.length} step(s) failed: ${failed.join(", ")}`
    : "\nAll selected steps passed.",
);
process.exit(failed.length > 0 ? 1 : 0);
