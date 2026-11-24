import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import {
  groupByCloudId,
  parseJiraSelection,
  parseProjectId,
  parseSiteId,
  projectItemId,
  siteItemId,
} from "../src/ids";

const CLOUD_ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLOUD_ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

test("project ids round trip through projectItemId/parseProjectId", () => {
  const id = projectItemId(CLOUD_ID_A, "10001");
  assert.equal(id, `project:${CLOUD_ID_A}:10001`);
  assert.deepEqual(parseProjectId(id), {
    cloudId: CLOUD_ID_A,
    projectId: "10001",
  });
});

test("site ids round trip through siteItemId/parseSiteId", () => {
  const id = siteItemId(CLOUD_ID_A);
  assert.equal(id, `site:${CLOUD_ID_A}`);
  assert.equal(parseSiteId(id), CLOUD_ID_A);
});

test("parseProjectId rejects a malformed cloud id, a non-numeric project id and a site id", () => {
  assert.equal(parseProjectId("project:x:1"), null);
  assert.equal(parseProjectId(`project:${CLOUD_ID_A}:abc`), null);
  assert.equal(parseProjectId(`site:${CLOUD_ID_A}`), null);
  assert.equal(
    parseProjectId(`project:${CLOUD_ID_A.toUpperCase()}:1`),
    null,
  );
});

function assertInvalidSelection(fn: () => unknown) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "JIRA_INVALID_SELECTION");
    return true;
  });
}

test("parseJiraSelection rejects project:x:1 as a selection item", () => {
  assertInvalidSelection(() =>
    parseJiraSelection({ items: [{ id: "project:x:1", kind: "project" }] }),
  );
});

test("parseJiraSelection rejects project:<uuid>:abc as a selection item", () => {
  assertInvalidSelection(() =>
    parseJiraSelection({
      items: [{ id: `project:${CLOUD_ID_A}:abc`, kind: "project" }],
    }),
  );
});

test("parseJiraSelection rejects site:<uuid> as a selection item", () => {
  assertInvalidSelection(() =>
    parseJiraSelection({
      items: [{ id: `site:${CLOUD_ID_A}`, kind: "project" }],
    }),
  );
});

test("parseJiraSelection rejects an upper-case cloud id", () => {
  assertInvalidSelection(() =>
    parseJiraSelection({
      items: [
        { id: `project:${CLOUD_ID_A.toUpperCase()}:1`, kind: "project" },
      ],
    }),
  );
});

test("parseJiraSelection rejects a wrong kind", () => {
  assertInvalidSelection(() =>
    parseJiraSelection({
      items: [{ id: projectItemId(CLOUD_ID_A, "1"), kind: "site" }],
    }),
  );
});

test("parseJiraSelection rejects duplicate ids", () => {
  const id = projectItemId(CLOUD_ID_A, "1");
  assertInvalidSelection(() =>
    parseJiraSelection({
      items: [
        { id, kind: "project" },
        { id, kind: "project" },
      ],
    }),
  );
});

test("parseJiraSelection rejects more than 100 items", () => {
  const items = Array.from({ length: 101 }, (_, index) => ({
    id: projectItemId(CLOUD_ID_A, String(index + 1)),
    kind: "project",
  }));
  assertInvalidSelection(() => parseJiraSelection({ items }));
});

test("parseJiraSelection accepts exactly 100 items", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: projectItemId(CLOUD_ID_A, String(index + 1)),
    kind: "project",
  }));
  const result = parseJiraSelection({ items });
  assert.equal(result.length, 100);
});

test("groupByCloudId groups project ids and sorts by cloud id", () => {
  const selection = parseJiraSelection({
    items: [
      { id: projectItemId(CLOUD_ID_B, "2"), kind: "project" },
      { id: projectItemId(CLOUD_ID_A, "1"), kind: "project" },
      { id: projectItemId(CLOUD_ID_A, "3"), kind: "project" },
    ],
  });
  const grouped = groupByCloudId(selection);
  assert.deepEqual(
    [...grouped.keys()],
    [CLOUD_ID_A, CLOUD_ID_B],
  );
  assert.deepEqual(grouped.get(CLOUD_ID_A), ["1", "3"]);
  assert.deepEqual(grouped.get(CLOUD_ID_B), ["2"]);
});
