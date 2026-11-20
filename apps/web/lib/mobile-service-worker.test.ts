// Runs public/sw.js against an in-memory Cache API and fetch.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, expect, test, vi } from "vitest";

const source = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
const ORIGIN = "https://sourceweft.com";

type Listener = (event: unknown) => void;

const key = (request: RequestInfo) =>
  new URL(typeof request === "string" ? request : request.url, ORIGIN).href;

function loadWorker(network: (request: Request) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: async (request: RequestInfo) => store.get(key(request))?.clone(),
        put: async (request: RequestInfo, response: Response) => {
          store.set(key(request), response);
        },
        keys: async () => [...store.keys()].map((url) => new Request(url)),
        delete: async (request: Request) => store.delete(request.url),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const listeners = new Map<string, Listener>();
  // The worker passes paths as well as requests, as the real Cache API and
  // fetch accept both.
  const fetch = vi.fn((input: RequestInfo) =>
    network(typeof input === "string" ? new Request(key(input)) : input),
  );
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

  async function install() {
    const background: Promise<unknown>[] = [];
    listeners.get("install")?.({
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    });
    await Promise.all(background);
  }

  return { dispatch, install, fetch, stores };
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

// A page that names two build files, as a Next.js page does in its script and link tags.
const pageWithFiles = (version: string) =>
  new Response(
    `<link rel="stylesheet" href="/_next/static/css/${version}.css"><script src="/_next/static/chunks/${version}.js"></script>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );

test("installing caches the shell pages, their build files and the brand images", async () => {
  const worker = loadWorker(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/dashboard/chat") return pageWithFiles("a");
    if (pathname === "/auth/sign-in") return pageWithFiles("b");
    return new Response(`file ${pathname}`, { status: 200 });
  });
  await worker.install();

  const shell = [...(worker.stores.get("sourceweft-shell-v1")?.keys() ?? [])];
  expect(shell.map((url) => new URL(url).pathname).sort()).toEqual([
    "/auth/sign-in",
    "/dashboard/chat",
    "/icon-192.png",
    "/icon.svg",
    "/logo-white-bg.svg",
    "/logo.svg",
  ]);
  const files = [...(worker.stores.get("sourceweft-static-v1")?.keys() ?? [])];
  expect(files.map((url) => new URL(url).pathname).sort()).toEqual([
    "/_next/static/chunks/a.js",
    "/_next/static/chunks/b.js",
    "/_next/static/css/a.css",
    "/_next/static/css/b.css",
  ]);

  // The first launch after installing is served from the cache.
  const launch = await worker.dispatch("/auth/sign-in");
  expect(launch?.headers.get("server-timing")).toContain("sw-shell-cache");
});

test("installing still succeeds offline and skips redirected pages", async () => {
  const offline = loadWorker((request) =>
    Promise.reject(new TypeError(`offline: ${request.url}`)),
  );
  await expect(offline.install()).resolves.toBeUndefined();

  const signedOut = loadWorker(async (request) => {
    const response = pageWithFiles("x");
    if (new URL(request.url).pathname === "/dashboard/chat") {
      Object.defineProperty(response, "redirected", { value: true });
    }
    return response;
  });
  await signedOut.install();
  const shell = [
    ...(signedOut.stores.get("sourceweft-shell-v1")?.keys() ?? []),
  ];
  expect(shell.some((url) => url.endsWith("/dashboard/chat"))).toBe(false);
  expect(shell.some((url) => url.endsWith("/auth/sign-in"))).toBe(true);
});

test("refreshing a page caches the build files a new deploy names", async () => {
  let version = "old";
  const worker = loadWorker(async (request) =>
    new URL(request.url).pathname === "/auth/sign-in"
      ? pageWithFiles(version)
      : new Response("file", { status: 200 }),
  );
  await worker.dispatch("/auth/sign-in");
  version = "new";
  // Served from the cache; the background refresh fetches the new page and its files.
  await worker.dispatch("/auth/sign-in");
  const files = [...(worker.stores.get("sourceweft-static-v1")?.keys() ?? [])];
  expect(files.some((url) => url.endsWith("/_next/static/chunks/new.js"))).toBe(
    true,
  );
});
