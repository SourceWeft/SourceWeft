import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";
import { sniffTtsAudioFormat } from "../src/tts/sniff";

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const WAV = bytes(...ascii("RIFF"), 36, 0, 0, 0, ...ascii("WAVE"), 1, 2, 3, 4);
const MP3_ID3 = bytes(...ascii("ID3"), 4, 0, 0, 0, 0, 0, 0);
const MP3_FRAME = bytes(0xff, 0xf3, 0x64, 0xc4, 0, 0, 0, 0);
const OGG = bytes(...ascii("OggS"), 0, 2, 0, 0);
const FLAC = bytes(...ascii("fLaC"), 0, 0, 0, 34);

test("audio is identified by its bytes", () => {
  assert.equal(sniffTtsAudioFormat(WAV), "wav");
  assert.equal(sniffTtsAudioFormat(MP3_ID3), "mp3");
  assert.equal(sniffTtsAudioFormat(MP3_FRAME), "mp3");
  assert.equal(sniffTtsAudioFormat(OGG), "opus");
  assert.equal(sniffTtsAudioFormat(FLAC), "flac");
  // ADTS AAC shares the sync word with MP3 but has layer bits 00.
  assert.equal(sniffTtsAudioFormat(bytes(0xff, 0xf1, 0x50, 0x80)), undefined);
  assert.equal(sniffTtsAudioFormat(bytes(1, 2, 3, 4)), undefined);
  assert.equal(sniffTtsAudioFormat(bytes()), undefined);
});

function build(input: {
  body: Uint8Array;
  contentType: string;
  transcoder?: boolean;
}) {
  const transcodes: Array<{ fromFormat: string; toFormat: string }> = [];
  const gateway = createModelGateway({
    fetch: async () =>
      new Response(new Blob([new Uint8Array(input.body)]), {
        headers: { "Content-Type": input.contentType },
      }),
    ...(input.transcoder
      ? {
          ttsAudioTranscoder: {
            async transcode(request) {
              transcodes.push({
                fromFormat: request.fromFormat,
                toFormat: request.toFormat,
              });
              return MP3_ID3;
            },
          },
        }
      : {}),
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "k",
      },
    },
    modelRoutes: {
      tts: {
        strategy: "priority",
        targets: [{ provider: "deepinfra", model: "some/tts", priority: 1 }],
      },
    },
  });
  return { gateway, transcodes };
}

test("WAV returned for an mp3 request, labelled audio/mpeg, is converted to mp3", async () => {
  const { gateway, transcodes } = build({
    body: WAV,
    contentType: "audio/mpeg",
    transcoder: true,
  });
  const result = await gateway.tts.speech({
    model: "tts",
    input: "Hi",
    responseFormat: "mp3",
  });
  assert.deepEqual(transcodes, [{ fromFormat: "wav", toFormat: "mp3" }]);
  assert.deepEqual([...new Uint8Array(result.audio)], [...MP3_ID3]);
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.raw.convertedFrom, "wav");
  assert.equal(result.raw.convertedTo, "mp3");
});

test("without a transcoder the audio is kept and its type is reported truthfully", async () => {
  const { gateway } = build({ body: WAV, contentType: "audio/mpeg" });
  const result = await gateway.tts.speech({
    model: "tts",
    input: "Hi",
    responseFormat: "mp3",
  });
  assert.deepEqual([...new Uint8Array(result.audio)], [...WAV]);
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.raw.convertedFrom, undefined);
});

test("audio already in the requested format is not touched", async () => {
  const { gateway, transcodes } = build({
    body: MP3_FRAME,
    contentType: "audio/mpeg",
    transcoder: true,
  });
  const result = await gateway.tts.speech({
    model: "tts",
    input: "Hi",
    responseFormat: "mp3",
  });
  assert.equal(transcodes.length, 0);
  assert.equal(result.mimeType, "audio/mpeg");
});

test("with no format requested, whatever the provider returns stands", async () => {
  const { gateway, transcodes } = build({
    body: WAV,
    contentType: "audio/wav",
    transcoder: true,
  });
  const result = await gateway.tts.speech({ model: "tts", input: "Hi" });
  assert.equal(transcodes.length, 0);
  assert.equal(result.mimeType, "audio/wav");
});

test("unrecognized bytes and raw pcm requests are left alone", async () => {
  for (const [body, responseFormat] of [
    [bytes(1, 2, 3, 4), "mp3"],
    [WAV, "pcm"],
  ] as const) {
    const { gateway, transcodes } = build({
      body,
      contentType: "audio/mpeg",
      transcoder: true,
    });
    await gateway.tts.speech({ model: "tts", input: "Hi", responseFormat });
    assert.equal(transcodes.length, 0);
  }
});

test("a provider that reports no usage is billed by the characters sent", async () => {
  const { gateway } = build({ body: MP3_FRAME, contentType: "audio/mpeg" });
  const result = await gateway.tts.speech({
    model: "tts",
    // 4 Chinese characters, a comma, 2 Latin letters and an emoji: 8.
    input: "你好世界,ab😀",
    responseFormat: "mp3",
  });
  assert.equal(result.usage?.inputCharacters, 8);
  assert.equal(result.observation?.usage?.inputCharacters, 8);
});

test("the character count survives a format conversion", async () => {
  const { gateway } = build({
    body: WAV,
    contentType: "audio/mpeg",
    transcoder: true,
  });
  const result = await gateway.tts.speech({
    model: "tts",
    input: "Hello",
    responseFormat: "mp3",
  });
  assert.equal(result.raw.convertedFrom, "wav");
  assert.equal(result.usage?.inputCharacters, 5);
});
