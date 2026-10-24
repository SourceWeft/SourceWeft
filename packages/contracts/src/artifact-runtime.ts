import {
  ARTIFACT_BRIDGE_VERSION,
  ARTIFACT_NAVIGATION_OPEN,
  ARTIFACT_RECORD_KV_COLLECTION,
  ARTIFACT_RECORD_LIMITS,
  ARTIFACT_STORAGE_HELLO,
  ARTIFACT_STORAGE_WELCOME,
} from "./artifact-records";

/**
 * The host runtime served inline at the top of every HTML artifact the
 * SourceWeft host renders.
 *
 * It is injected when the file is served for rendering (never into the stored
 * bytes, the download or the source view), so every published version gets it
 * without republishing and its behaviour moves with the host. It runs inside
 * the page's own sandbox and holds no credential: everything it can do, the
 * page could do itself. Its two jobs:
 *
 * - route link clicks to the host, which shows the leave-SourceWeft
 *   confirmation instead of navigating the frame;
 * - expose `window.sourceweft.storage`, a thin client over the host's
 *   MessagePort bridge. When the version does not declare storage every call
 *   rejects with `unavailable`, so a page can degrade explicitly.
 *
 * Keep it dependency-free ES2017 — it is a string, not a bundle.
 */
export function buildArtifactRuntimeScript(input: {
  storage: boolean;
}): string {
  const constants = JSON.stringify({
    hello: ARTIFACT_STORAGE_HELLO,
    welcome: ARTIFACT_STORAGE_WELCOME,
    open: ARTIFACT_NAVIGATION_OPEN,
    v: ARTIFACT_BRIDGE_VERSION,
    kv: ARTIFACT_RECORD_KV_COLLECTION,
    maxDepth: ARTIFACT_RECORD_LIMITS.maxDepth,
    storage: input.storage,
  });
  return `(function () {
  "use strict";
  var C = ${constants};
  var host = window.parent;
  if (!host || host === window) return;

  function linkTarget(event) {
    var node = event.target;
    while (node && node.nodeType !== 1) node = node.parentNode;
    var anchor = node && node.closest ? node.closest("a[href], a[*|href]") : null;
    if (!anchor) return null;
    var raw = anchor.getAttribute("href") || anchor.getAttribute("xlink:href") || "";
    if (raw.charAt(0) === "#") return null;
    try {
      return new URL(raw, document.baseURI).href;
    } catch (error) {
      return "";
    }
  }
  function onLink(event) {
    if (event.type === "auxclick" && event.button !== 1) return;
    var url = linkTarget(event);
    if (url === null) return;
    event.preventDefault();
    if (url) host.postMessage({ type: C.open, v: C.v, url: url }, "*");
  }
  document.addEventListener("click", onLink, true);
  document.addEventListener("auxclick", onLink, true);

  function failure(code, message) {
    var error = new Error(message || code);
    error.name = "ArtifactStorageError";
    error.code = code;
    return error;
  }
  function checkJson(value, depth) {
    if (depth > C.maxDepth) throw failure("invalid_request", "JSON nesting is too deep");
    if (value === null || typeof value === "boolean" || typeof value === "string") return;
    if (typeof value === "number") {
      if (!isFinite(value)) throw failure("invalid_request", "Numbers must be finite");
      return;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) checkJson(value[i], depth + 1);
      return;
    }
    if (typeof value === "object") {
      var proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw failure("invalid_request", "Only plain JSON objects can be stored");
      for (var key in value)
        if (Object.prototype.hasOwnProperty.call(value, key)) checkJson(value[key], depth + 1);
      return;
    }
    throw failure("invalid_request", "Only JSON values can be stored");
  }

  var pending = new Map();
  var nextId = 0;
  var portPromise = null;
  function connect() {
    if (!C.storage)
      return Promise.reject(failure("unavailable", "This page does not declare storage"));
    if (portPromise) return portPromise;
    portPromise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        window.removeEventListener("message", onWelcome);
        portPromise = null;
        reject(failure("unavailable", "Storage is not available here"));
      }, 5000);
      function onWelcome(event) {
        if (event.source !== host) return;
        var data = event.data;
        if (!data || data.type !== C.welcome || !event.ports || !event.ports[0]) return;
        clearTimeout(timer);
        window.removeEventListener("message", onWelcome);
        var port = event.ports[0];
        port.onmessage = function (message) {
          var reply = message.data;
          var entry = reply && pending.get(reply.requestId);
          if (!entry) return;
          pending.delete(reply.requestId);
          clearTimeout(entry.timer);
          if (reply.ok) entry.resolve(reply.result);
          else entry.reject(failure(reply.error && reply.error.code, reply.error && reply.error.message));
        };
        resolve(port);
      }
      window.addEventListener("message", onWelcome);
      host.postMessage({ type: C.hello, v: C.v }, "*");
    });
    return portPromise;
  }
  function call(operation) {
    return connect().then(function (port) {
      return new Promise(function (resolve, reject) {
        var requestId = nextId++;
        var timer = setTimeout(function () {
          pending.delete(requestId);
          reject(failure("unavailable", "Storage did not answer"));
        }, 15000);
        pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
        port.postMessage({ requestId: requestId, operation: operation });
      });
    });
  }
  function clean(object) {
    var out = {};
    for (var key in object) if (object[key] !== undefined) out[key] = object[key];
    return out;
  }
  function scopeOf(options) {
    return (options && options.scope) || "user";
  }
  function collection(name, options) {
    var scope = scopeOf(options);
    return Object.freeze({
      get: function (id) {
        return call({ op: "get", scope: scope, collection: name, id: id }).then(function (result) {
          return result.record;
        });
      },
      set: function (id, data, setOptions) {
        try {
          checkJson(data, 1);
        } catch (error) {
          return Promise.reject(error);
        }
        return call(clean({ op: "set", scope: scope, collection: name, id: id, data: data, ifMatch: setOptions && setOptions.ifMatch })).then(function (result) {
          return { etag: result.etag };
        });
      },
      delete: function (id, deleteOptions) {
        return call(clean({ op: "delete", scope: scope, collection: name, id: id, ifMatch: deleteOptions && deleteOptions.ifMatch })).then(function () {});
      },
      query: function (query) {
        query = query || {};
        return call(clean({ op: "query", scope: scope, collection: name, where: query.where, orderBy: query.orderBy, limit: query.limit, cursor: query.cursor })).then(function (result) {
          return clean({ records: result.records, cursor: result.cursor || undefined });
        });
      }
    });
  }
  var storage = Object.freeze({
    collection: collection,
    get: function (key, options) {
      return collection(C.kv, options).get(key).then(function (record) {
        return record ? record.data : null;
      });
    },
    set: function (key, value, options) {
      return collection(C.kv, options).set(key, value, options);
    },
    delete: function (key, options) {
      return collection(C.kv, options).delete(key, options);
    },
    list: function (prefix, options) {
      return call(clean({ op: "query", scope: scopeOf(options), collection: C.kv, idPrefix: prefix || "", limit: options && options.limit, cursor: options && options.cursor })).then(function (result) {
        return clean({
          keys: result.records.map(function (record) {
            return { key: record.id, etag: record.etag, updatedAt: record.updatedAt };
          }),
          cursor: result.cursor || undefined
        });
      });
    }
  });
  Object.defineProperty(window, "sourceweft", {
    value: Object.freeze({ storage: storage }),
    configurable: false,
    enumerable: false,
    writable: false
  });
})();`;
}

const RUNTIME_ATTRIBUTE = "data-sourceweft-runtime";

/**
 * Inserts the runtime right after the document's `<html …>` start tag, so it
 * runs before any page script and the document keeps its doctype (inserting
 * before the doctype would switch the page to quirks mode).
 *
 * Published HTML is validated to begin with an explicit `<html>` element, so
 * only a BOM, whitespace, comments and the doctype may precede it. Anything
 * else returns null and the caller serves the document without a runtime —
 * failing closed, since without the runtime the page simply has no storage and
 * plain links do nothing, exactly as before this feature.
 */
export function injectArtifactRuntime(
  html: string,
  script: string,
): string | null {
  if (/<\/script/iu.test(script)) return null;
  let index = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (index < html.length && /\s/u.test(html[index]!)) index++;
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    if (/^<!doctype[\s>]/iu.test(html.slice(index, index + 10))) {
      const end = html.indexOf(">", index);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    break;
  }
  if (!/^<html[\s/>]/iu.test(html.slice(index, index + 6))) return null;
  let cursor = index + 5;
  let quote: string | null = null;
  for (; cursor < html.length; cursor++) {
    const char = html[cursor]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      const insertAt = cursor + 1;
      return `${html.slice(0, insertAt)}<script ${RUNTIME_ATTRIBUTE}>${script}</script>${html.slice(insertAt)}`;
    }
  }
  return null;
}
