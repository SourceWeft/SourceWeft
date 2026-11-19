import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "../src/errors";
import type { AtlassianClientConfig } from "../src/http";
import { getMe, listAccessibleResources } from "../src/resources";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function config(fetcher: typeof fetch): AtlassianClientConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    errorPrefix: "JIRA",
    fetcher,
  };
}

test("accessible resources are mapped, filtered and sorted", async () => {
  let capturedUrl = "";
  const client = config(async (url) => {
    capturedUrl = String(url);
    return json([
      {
        id: "bbbbbbbb-2222-3333-4444-555555555555",
        url: "https://second.atlassian.net",
        name: "Second",
        scopes: ["read:jira-work"],
      },
      { id: "not-a-cloud-id", url: "https://bad.example", name: "Bad" },
      {
        id: "aaaaaaaa-2222-3333-4444-555555555555",
        url: "https://first.atlassian.net",
        name: "First",
        scopes: ["read:jira-work", "offline_access"],
      },
    ]);
  });

  const sites = await listAccessibleResources(client, "access-token");

  assert.equal(capturedUrl, "https://api.atlassian.com/oauth/token/accessible-resources");
  assert.equal(sites.length, 2);
  assert.equal(sites[0]?.cloudId, "aaaaaaaa-2222-3333-4444-555555555555");
  assert.equal(sites[0]?.name, "First");
  assert.deepEqual(sites[0]?.scopes, ["read:jira-work", "offline_access"]);
  assert.equal(sites[1]?.cloudId, "bbbbbbbb-2222-3333-4444-555555555555");
});

test("accessible resources that are not an array are UNAVAILABLE", async () => {
  const client = config(async () => json({ not: "an array" }));

  await assert.rejects(listAccessibleResources(client, "access-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("me maps the identity fields", async () => {
  let capturedUrl = "";
  const client = config(async (url) => {
    capturedUrl = String(url);
    return json({ account_id: "account-1", email: "user@example.com", name: "User One" });
  });

  const identity = await getMe(client, "access-token");

  assert.equal(capturedUrl, "https://api.atlassian.com/me");
  assert.deepEqual(identity, {
    accountId: "account-1",
    email: "user@example.com",
    name: "User One",
  });
});

test("me without account_id requires reauthorization", async () => {
  const client = config(async () => json({ email: "user@example.com" }));

  await assert.rejects(getMe(client, "access-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "JIRA_REAUTH_REQUIRED");
    return true;
  });
});

test("a null identity payload is UNAVAILABLE", async () => {
  const client = config(async () => json(null));

  await assert.rejects(getMe(client, "access-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});
