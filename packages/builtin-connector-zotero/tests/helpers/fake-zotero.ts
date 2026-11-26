/**
 * An in-process fake of the Zotero Web API v3, exposed as a `fetch`. There are
 * no sockets: the fake is a function over `(url, init)` that records every
 * request and answers from a {@link FakeLibrary}. It serves `keys/current`,
 * `<prefix>/collections`, `<prefix>/items`, `<prefix>/items/KEY` and
 * `<prefix>/items/KEY/children` with `Last-Modified-Version`, `Total-Results`,
 * `start`/`limit` paging and `If-Modified-Since-Version` (304). Faults and
 * header mutations are injected per request with {@link FakeZotero.failNext}
 * and {@link FakeZotero.mutateNext}.
 */

export type FakeObject = {
  key: string;
  version?: number;
  [k: string]: unknown;
};

export type FakeLibrary = {
  /** `users/<id>` or `groups/<id>`; default `users/1`. */
  prefix?: string;
  /** Library version, sent as `Last-Modified-Version`; default 1. */
  version?: number;
  /** When set, a request whose `Zotero-API-Key` differs gets a 403. */
  apiKey?: string;
  /** The raw JSON body of `GET /keys/current`; a plausible default if unset. */
  keyInfo?: Record<string, unknown>;
  collections?: FakeObject[];
  /** Served in the given order by `/items` (a fixture sorts itself by `dateAdded`). */
  items?: FakeObject[];
  /** Child items keyed by parent item key, for `items/KEY/children`. */
  children?: Record<string, FakeObject[]>;
};

export type RecordedRequest = {
  method: string;
  /** Path without the query, e.g. `/users/1/items`. */
  path: string;
  /** Decoded query parameters (the last value wins for a repeated name). */
  query: Record<string, string>;
  /** Lower-cased request header names. */
  headers: Record<string, string>;
  url: string;
};

export type FakeFault =
  | {
      /** Answer with this status instead of serving the request. */
      status: number;
      headers?: Record<string, string>;
      body?: string;
    }
  | { networkError: true }
  /** Never answer; rejects with an AbortError when the request's signal aborts. */
  | { hang: true };

export type FakeZotero = {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  setLibrary(library: FakeLibrary): void;
  setVersion(version: number): void;
  /** The next `times` requests (optionally only those matching) get `fault`. */
  failNext(
    fault: FakeFault,
    times?: number,
    match?: (request: RecordedRequest) => boolean,
  ): void;
  /** Set (string) or remove (null) response headers on the next `times` served responses. */
  mutateNext(headers: Record<string, string | null>, times?: number): void;
};

const DEFAULT_KEY_INFO = {
  key: "fake",
  userID: 1,
  username: "alice",
  access: {
    user: { library: true, files: true, notes: true, write: false },
    groups: { all: { library: true, write: false } },
  },
};

function json(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function startFakeZotero(initial: FakeLibrary): FakeZotero {
  let library: FakeLibrary = { ...initial };
  const requests: RecordedRequest[] = [];
  const faults: {
    fault: FakeFault;
    left: number;
    match?: (request: RecordedRequest) => boolean;
  }[] = [];
  const mutations: {
    headers: Record<string, string | null>;
    left: number;
  }[] = [];

  const prefix = () => library.prefix ?? "users/1";
  const version = () => library.version ?? 1;

  function serve(request: RecordedRequest): Response {
    const base = { "Last-Modified-Version": String(version()) };
    if (request.method !== "GET") return json({}, 405, {});
    if (
      library.apiKey !== undefined &&
      request.headers["zotero-api-key"] !== library.apiKey
    ) {
      return json({}, 403, {});
    }
    if (request.path === "/keys/current") {
      return json(library.keyInfo ?? DEFAULT_KEY_INFO, 200, {});
    }
    const root = `/${prefix()}/`;
    if (!request.path.startsWith(root)) return json({}, 404, {});
    const rest = request.path.slice(root.length);

    const since = request.headers["if-modified-since-version"];
    if (since !== undefined && Number(since) >= version()) {
      return new Response(null, { status: 304, headers: base });
    }

    const page = (all: FakeObject[]): Response => {
      const start = Number(request.query.start ?? "0");
      const limit = Number(request.query.limit ?? "25");
      return json(all.slice(start, start + limit), 200, {
        ...base,
        "Total-Results": String(all.length),
      });
    };

    if (rest === "collections") return page(library.collections ?? []);
    if (rest === "items") return page(library.items ?? []);
    const child = /^items\/([A-Z0-9]{8})\/children$/.exec(rest);
    if (child) {
      const key = child[1] as string;
      const known = (library.items ?? []).some((item) => item.key === key);
      if (!known) return json({}, 404, {});
      return page(library.children?.[key] ?? []);
    }
    const single = /^items\/([A-Z0-9]{8})$/.exec(rest);
    if (single) {
      const found = (library.items ?? []).find(
        (item) => item.key === single[1],
      );
      return found ? json(found, 200, base) : json({}, 404, {});
    }
    return json({}, 404, {});
  }

  const fakeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, name) => {
      query[name] = value;
    });
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query,
      headers,
      url: url.toString(),
    };
    requests.push(request);

    const index = faults.findIndex((f) => !f.match || f.match(request));
    const pending = index === -1 ? undefined : faults[index];
    if (pending) {
      pending.left -= 1;
      if (pending.left <= 0) faults.splice(index, 1);
      const { fault } = pending;
      if ("networkError" in fault) throw new TypeError("fetch failed");
      if ("hang" in fault) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      const bodyless = [101, 204, 205, 304].includes(fault.status);
      return new Response(bodyless ? null : (fault.body ?? ""), {
        status: fault.status,
        headers: fault.headers,
      });
    }

    const response = serve(request);
    const mutation = mutations[0];
    if (!mutation) return response;
    mutation.left -= 1;
    if (mutation.left <= 0) mutations.shift();
    const merged = new Headers(response.headers);
    for (const [name, value] of Object.entries(mutation.headers)) {
      if (value === null) merged.delete(name);
      else merged.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers: merged,
    });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requests,
    setLibrary(next) {
      library = { ...next };
    },
    setVersion(next) {
      library = { ...library, version: next };
    },
    failNext(fault, times = 1, match) {
      faults.push({ fault, left: times, match });
    },
    mutateNext(headers, times = 1) {
      mutations.push({ headers, left: times });
    },
  };
}
