import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { sha256 } from "@sourceweft/skill-format";
import {
  assertPinnedRepo,
  downloadRepoZip,
  fetchSkillFiles,
  GitHubSourceError,
  MAX_ARCHIVE_BYTES,
  type PinnedRepo,
} from "../src/source/github";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const source: PinnedRepo = { owner: "acme", repo: "skills", commitSha: SHA };

const archive = zipSync({
  [`skills-${SHA}/pdf/SKILL.md`]: strToU8("# pdf"),
  [`skills-${SHA}/pdf/run.sh`]: strToU8("echo hi"),
});

type Handler = (
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
) => void;

describe("assertPinnedRepo", () => {
  it("accepts a well-formed pinned source", () => {
    assert.doesNotThrow(() => assertPinnedRepo(source));
  });

  it("rejects anything that is not a full commit sha", () => {
    for (const commitSha of [
      "main",
      "v1.0",
      SHA.slice(0, 7),
      SHA.toUpperCase(),
      "",
    ]) {
      assert.throws(
        () => assertPinnedRepo({ ...source, commitSha }),
        GitHubSourceError,
      );
    }
  });

  it("rejects owners and repos that could alter the request path", () => {
    for (const bad of [
      { owner: "a/b", repo: "r" },
      { owner: "a", repo: "r/../x" },
      { owner: "-a", repo: "r" },
      { owner: "a", repo: ".." },
      { owner: "a", repo: "" },
      { owner: "a?x=1", repo: "r" },
    ]) {
      assert.throws(
        () => assertPinnedRepo({ ...source, ...bad }),
        GitHubSourceError,
        JSON.stringify(bad),
      );
    }
  });
});

describe("downloadRepoZip", () => {
  let server: Server;
  let baseUrl = "";
  let handler: Handler = (_req, res) => res.end();
  const seen: IncomingMessage[] = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push(req);
      handler(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("downloads the pinned archive from the codeload path", async () => {
    seen.length = 0;
    handler = (_req, res) => {
      res.setHeader("content-type", "application/zip");
      res.end(Buffer.from(archive));
    };
    const zip = await downloadRepoZip(source, { baseUrl });
    assert.equal(seen[0]?.url, `/acme/skills/zip/${SHA}`);
    assert.equal(sha256(zip), sha256(archive));
  });

  it("sends the token, and reads the skill's files out of the archive", async () => {
    seen.length = 0;
    handler = (_req, res) => res.end(Buffer.from(archive));
    const files = await fetchSkillFiles(
      source,
      { subpath: "pdf", keep: (path) => path === "SKILL.md" },
      { baseUrl, token: "t0ken" },
    );
    assert.equal(seen[0]?.headers.authorization, "Bearer t0ken");
    assert.deepEqual([...files.keys()], ["SKILL.md"]);
  });

  it("follows a redirect within a trusted host and keeps the token", async () => {
    seen.length = 0;
    handler = (req, res) => {
      if (req.url?.startsWith("/acme")) {
        res.statusCode = 302;
        res.setHeader("location", "/final.zip");
        res.end();
        return;
      }
      res.end(Buffer.from(archive));
    };
    const zip = await downloadRepoZip(source, { baseUrl, token: "t0ken" });
    assert.equal(sha256(zip), sha256(archive));
    assert.equal(seen[1]?.url, "/final.zip");
    assert.equal(seen[1]?.headers.authorization, "Bearer t0ken");
  });

  it("refuses a redirect to an untrusted host rather than leaking the token", async () => {
    seen.length = 0;
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "https://evil.example/steal.zip");
      res.end();
    };
    await assert.rejects(
      downloadRepoZip(source, { baseUrl, token: "t0ken" }),
      (error) =>
        error instanceof GitHubSourceError && error.code === "UNAVAILABLE",
    );
    assert.equal(seen.length, 1);
  });

  it("gives up on a redirect loop", async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/again");
      res.end();
    };
    await assert.rejects(
      downloadRepoZip(source, { baseUrl }),
      (error) =>
        error instanceof GitHubSourceError && error.code === "UNAVAILABLE",
    );
  });

  it("maps 404 and rate limits to distinct codes", async () => {
    for (const [status, code] of [
      [404, "NOT_FOUND"],
      [403, "RATE_LIMITED"],
      [429, "RATE_LIMITED"],
      [500, "UNAVAILABLE"],
    ] as const) {
      handler = (_req, res) => {
        res.statusCode = status;
        res.end("nope");
      };
      await assert.rejects(
        downloadRepoZip(source, { baseUrl }),
        (error) => error instanceof GitHubSourceError && error.code === code,
        String(status),
      );
    }
  });

  it("refuses an archive whose advertised size is over the ceiling", async () => {
    handler = (_req, res) => {
      res.setHeader("content-length", String(MAX_ARCHIVE_BYTES + 1));
      res.flushHeaders();
      res.destroy();
    };
    await assert.rejects(
      downloadRepoZip(source, { baseUrl }),
      (error) => error instanceof GitHubSourceError,
    );
  });

  it("reports an unreachable host as unavailable", async () => {
    await assert.rejects(
      downloadRepoZip(source, {
        baseUrl: "http://127.0.0.1:1",
        timeoutMs: 2000,
      }),
      (error) =>
        error instanceof GitHubSourceError && error.code === "UNAVAILABLE",
    );
  });
});
