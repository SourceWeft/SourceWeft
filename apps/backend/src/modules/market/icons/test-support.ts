import sharp from "sharp";
import { createIconFetcher, type IconTransport } from "./icon-fetcher";
import { createMemoryIconStateStore } from "./icon-state";
import { sha256Hex } from "./image-validate";
import type { HashedIconStore } from "./store";

/**
 * Shared fixtures for the icon dry-run tests: a transport that answers by URL,
 * generated logos, and a hashed icon store that keeps what it is given.
 */

export type Answer = Response | (() => Response) | Error;

/**
 * A fresh copy of a canned response on every request. (`Response.clone()`
 * tees the body, and cancelling one branch of a tee never settles while the
 * other is unread.)
 */
export function replayable(answer: Response) {
  let template: Promise<{ body: ArrayBuffer; init: ResponseInit }> | undefined;
  return async () => {
    template ??= answer
      .clone()
      .arrayBuffer()
      .then((body) => ({
        body,
        init: {
          status: answer.status,
          headers: [...answer.headers.entries()],
        },
      }));
    const { body, init } = await template;
    return new Response(answer.status === 204 ? null : body.slice(0), init);
  };
}

export function fakeNetwork(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const replays = new Map<string, () => Promise<Response>>();
  const transport: IconTransport = async (url) => {
    calls.push(url.toString());
    const answer = answers[url.toString()];
    if (!answer) return new Response("not found", { status: 404 });
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    let replay = replays.get(url.toString());
    if (!replay) {
      replay = replayable(answer);
      replays.set(url.toString(), replay);
    }
    return replay();
  };
  return {
    calls,
    answers,
    createFetcher: (options: Parameters<typeof createIconFetcher>[0]) =>
      createIconFetcher({ ...options, transport }),
  };
}

export const html = (head: string, status = 200) =>
  new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, {
    status,
    headers: { "content-type": "text/html" },
  });

export const imageResponse = (bytes: Buffer, type = "image/png") =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });

/** A distinct two-tone square logo per colour seed. */
export async function logo(seed: number, size = 128) {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: (seed * 53) % 256, g: (seed * 97) % 256, b: (seed * 31 + 60) % 256, alpha: 1 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: Math.floor(size / 2),
            height: Math.floor(size / 2),
            channels: 4,
            background: { r: 255 - ((seed * 53) % 256), g: 240, b: 30, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
        gravity: "centre",
      },
    ])
    .png()
    .toBuffer();
}

export function memoryHashedStore() {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const store: HashedIconStore = async ({ sha256, bytes, contentType }) => {
    if (sha256 !== sha256Hex(bytes)) throw new Error("hash does not match bytes");
    objects.set(sha256, { bytes, contentType });
    return { url: `https://assets.test/market/mcp-icons/by-hash/${sha256}.png` };
  };
  return { store, objects };
}

export function testDeps() {
  const state = createMemoryIconStateStore();
  const stored = memoryHashedStore();
  return { state, ...stored };
}
