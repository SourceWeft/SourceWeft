import assert from "node:assert/strict";
import { test } from "vitest";
import { EndpointPolicyError } from "../../shared/security/endpoint-policy";
import { createPublicFetchScope } from "./public-fetch";

test("the public scope rejects a private address", async () => {
  const scope = createPublicFetchScope();
  try {
    await assert.rejects(
      scope.fetch("https://10.0.0.1/feed"),
      EndpointPolicyError,
    );
  } finally {
    await scope.close();
  }
});

test("the public scope rejects http, which the public-only policy refuses", async () => {
  const scope = createPublicFetchScope();
  try {
    await assert.rejects(
      scope.fetch("http://example.com/feed"),
      EndpointPolicyError,
    );
  } finally {
    await scope.close();
  }
});

test("close resolves and leaves the scope unusable", async () => {
  const scope = createPublicFetchScope();
  await scope.close();
  await assert.rejects(scope.fetch("https://example.com/feed"), /closed/);
});

test("each call opens an independent scope", async () => {
  const first = createPublicFetchScope();
  const second = createPublicFetchScope();
  try {
    assert.notEqual(first, second);
    await first.close();
    // A denial or close in one scope does not poison the other.
    await assert.rejects(
      second.fetch("https://10.0.0.1/feed"),
      EndpointPolicyError,
    );
    await assert.rejects(
      second.fetch("https://10.0.0.2/feed"),
      EndpointPolicyError,
    );
  } finally {
    await second.close();
  }
});
