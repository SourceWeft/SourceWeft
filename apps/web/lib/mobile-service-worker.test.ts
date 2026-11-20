// Runs public/sw.js against an in-memory Cache API and fetch.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, expect, test, vi } from "vitest";

const source = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
const ORIGIN = "https://sourceweft.com";

type Listener = (event: unknown) => void;

function loadWorker(network: (request: Request) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: async (request: Request) => store.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          store.set(request.url, response);
        },
        keys: async () => [...store.keys()].map((url) => new Request(url)),
        delete: async (request: Request) => store.delete(request.url),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const listeners = new Map<string, Listener>();
  const fetch = vi.fn(network);
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  runInNewContext(source, {
    self,
    caches,
    fetch,
    URL,
    Headers,
    Response,
    Set,
    console,
  });

  async function dispatch(path: string, mode: RequestMode = "navigate") {
    const request = new Request(`${ORIGIN}${path}`);
    Object.defineProperty(request, "mode", { value: mode });
    let responded: Promise<Response> | undefined;
    const background: Promise<unknown>[] = [];
    listeners.get("fetch")?.({
      request,
      respondWith: (response: Promise<Response>) => {
        responded = response;
      },
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    });
    const response = await responded;
    await Promise.all(background);
    return response;
  }

  return { dispatch, fetch, stores };
}

let served = 0;
const page = () =>
  Promise.resolve(
    new Response(`page ${++served}`, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  );

beforeEach(() => {
  served = 0;
});

test("a shell page comes from the network first, then from the cache while it refreshes", async () => {
  const worker = loadWorker(page);

  const first = await worker.dispatch("/dashboard/chat");
  expect(await first?.text()).toBe("page 1");
  expect(first?.headers.get("server-timing")).toBeNull();

  const second = await worker.dispatch("/dashboard/chat");
  expect(await second?.text()).toBe("page 1");
  expect(second?.headers.get("server-timing")).toContain("sw-shell-cache");

  // The refresh that ran behind the second launch is what the third one gets.
  const third = await worker.dispatch("/dashboard/chat");
  expect(await third?.text()).toBe("page 2");
});

test("a cached shell page still opens when the network is down", async () => {
  let online = true;
  const worker = loadWorker((request) =>
    online ? page() : Promise.reject(new TypeError(`offline: ${request.url}`)),
  );
  await worker.dispatch("/auth/sign-in");
  online = false;
  const offline = await worker.dispatch("/auth/sign-in");
  expect(await offline?.text()).toBe("page 1");
});

test("other pages, queries and API calls are not touched", async () => {
  const worker = loadWorker(page);
  for (const path of [
    "/dashboard/chat/thread-1",
    "/dashboard/chat?x=1",
    "/terms",
    "/v1/health",
  ]) {
    expect(await worker.dispatch(path), path).toBeUndefined();
  }
  expect(await worker.dispatch("/auth/sign-in", "cors")).toBeUndefined();
});

test("redirected or failed responses are not kept", async () => {
  const worker = loadWorker(() =>
    Promise.resolve(new Response("nope", { status: 500 })),
  );
  await worker.dispatch("/auth/sign-in");
  await worker.dispatch("/auth/sign-in");
  expect(worker.fetch).toHaveBeenCalledTimes(2);
});

test("the brand images the shell pages show are kept like the pages", async () => {
  const worker = loadWorker(page);
  await worker.dispatch("/logo.svg", "no-cors");
  const again = await worker.dispatch("/logo.svg", "no-cors");
  expect(await again?.text()).toBe("page 1");
  expect(await worker.dispatch("/icons/github.svg", "no-cors")).toBeUndefined();
});

test("build files are served from the cache once fetched", async () => {
  const worker = loadWorker(() => Promise.resolve(new Response("js")));
  await worker.dispatch("/_next/static/chunks/app.js", "no-cors");
  const again = await worker.dispatch("/_next/static/chunks/app.js", "no-cors");
  expect(await again?.text()).toBe("js");
  expect(worker.fetch).toHaveBeenCalledTimes(1);
});
