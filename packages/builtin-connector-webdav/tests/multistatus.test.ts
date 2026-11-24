import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WebDavError } from "../src/errors";
import { MAX_MULTISTATUS_BYTES } from "../src/limits";
import { parseMultistatus } from "../src/multistatus";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function badResponse(xml: string): WebDavError {
  try {
    parseMultistatus(xml);
  } catch (error) {
    assert.ok(error instanceof WebDavError, "expected WebDavError");
    return error;
  }
  assert.fail("expected rejection");
}

test("parses a Nextcloud multistatus with prefixed DAV: elements", () => {
  const entries = parseMultistatus(fixture("nextcloud.xml"));
  assert.equal(entries.length, 3);
  const [folder, file, sub] = entries;
  assert.deepEqual(folder, {
    href: "/remote.php/dav/files/alice/Documents/",
    isCollection: true,
    etag: '"6564bd4a2d1c8"',
    lastModified: new Date("2026-11-23T10:00:00Z"),
    contentLength: null,
    contentType: null,
  });
  assert.deepEqual(file, {
    href: "/remote.php/dav/files/alice/Documents/My%20Report.pdf",
    isCollection: false,
    etag: '"a1b2c3d4"',
    lastModified: new Date("2026-11-22T08:30:15Z"),
    contentLength: 48213,
    contentType: "application/pdf",
  });
  assert.equal(sub?.isCollection, true);
});

test("parses an Apache mod_dav multistatus (D: and lp1: prefixes)", () => {
  const entries = parseMultistatus(fixture("apache.xml"));
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.isCollection, true);
  assert.equal(entries[0]?.etag, '"1000-5f"');
  assert.deepEqual(entries[1], {
    href: "/dav/notes.md",
    isCollection: false,
    etag: '"78-5f"',
    lastModified: new Date("2026-11-17T09:05:00Z"),
    contentLength: 120,
    contentType: "text/markdown",
  });
});

test("tolerates a default namespace, missing and invalid properties", () => {
  const entries = parseMultistatus(fixture("default-namespace.xml"));
  // The second response has no propstat (a bare 404): it is not an entry.
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    href: "http://dav.example.com/dav/a%20b.txt",
    isCollection: false,
    etag: null,
    lastModified: null,
    contentLength: 5,
    contentType: null,
  });
});

test("properties only found in a 404 propstat read as null", () => {
  const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href>
    <d:propstat><d:prop><d:getcontentlength>9</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    <d:propstat><d:prop><d:getetag>"nope"</d:getetag></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
    </d:response></d:multistatus>`;
  const [entry] = parseMultistatus(xml);
  assert.equal(entry?.contentLength, 9);
  assert.equal(entry?.etag, null);
});

test("a response without any 2xx propstat still yields an entry when it has an href and a status-less propstat", () => {
  const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/only</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`;
  const entries = parseMultistatus(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.href, "/only");
});

test("a negative or non-numeric content length is null", () => {
  for (const value of ["-1", "abc", "1.5", "99999999999999999999999", ""]) {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href>
      <d:propstat><d:prop><d:getcontentlength>${value}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
      </d:response></d:multistatus>`;
    assert.equal(parseMultistatus(xml)[0]?.contentLength, null, value);
  }
});

test("an empty multistatus has no entries", () => {
  assert.deepEqual(parseMultistatus('<d:multistatus xmlns:d="DAV:"/>'), []);
});

test("keeps the first of duplicate hrefs", () => {
  const response = (length: number) =>
    `<d:response><d:href>/dup.txt</d:href><d:propstat><d:prop><d:getcontentlength>${length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const entries = parseMultistatus(
    `<d:multistatus xmlns:d="DAV:">${response(1)}${response(2)}</d:multistatus>`,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.contentLength, 1);
});

test("a response without an href is skipped", () => {
  const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  assert.deepEqual(parseMultistatus(xml), []);
});

test("malformed XML, wrong root and HTML fail with a fixed error", () => {
  for (const xml of [
    fixture("malformed.xml"),
    "<html><body>Login</body></html>",
    "<feed><entry/></feed>",
    "",
    "not xml at all",
  ]) {
    const error = badResponse(xml);
    assert.equal(error.code, "WEBDAV_BAD_RESPONSE");
    assert.equal(error.message.includes("Login"), false);
  }
});

test("an entity declaration (entity bomb) is rejected before expansion", () => {
  const started = Date.now();
  const error = badResponse(fixture("entity-bomb.xml"));
  assert.equal(error.code, "WEBDAV_BAD_RESPONSE");
  assert.ok(Date.now() - started < 2000);
});

test("the predefined XML entities still decode", () => {
  const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a&amp;b&lt;c&gt;&apos;.txt</d:href>
    <d:propstat><d:prop><d:getcontenttype>text/plain; charset=&quot;utf-8&quot;</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    </d:response></d:multistatus>`;
  const [entry] = parseMultistatus(xml);
  assert.equal(entry?.href, "/a&b<c>'.txt");
  assert.equal(entry?.contentType, 'text/plain; charset="utf-8"');
});

test("a document over the size cap is rejected without parsing", () => {
  const padding = " ".repeat(MAX_MULTISTATUS_BYTES);
  const error = badResponse(
    `<d:multistatus xmlns:d="DAV:">${padding}</d:multistatus>`,
  );
  assert.equal(error.code, "WEBDAV_BAD_RESPONSE");
});

test("multi-byte content is measured in bytes, not characters", () => {
  const padding = "é".repeat(Math.floor(MAX_MULTISTATUS_BYTES / 2));
  const error = badResponse(
    `<d:multistatus xmlns:d="DAV:"><!--${padding}--></d:multistatus>`,
  );
  assert.equal(error.code, "WEBDAV_BAD_RESPONSE");
});

test("deeply nested markup is rejected", () => {
  const depth = 500;
  const xml = `<d:multistatus xmlns:d="DAV:">${"<a>".repeat(depth)}${"</a>".repeat(depth)}</d:multistatus>`;
  assert.equal(badResponse(xml).code, "WEBDAV_BAD_RESPONSE");
});
