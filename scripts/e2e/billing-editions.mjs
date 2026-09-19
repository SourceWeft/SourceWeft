import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const api = process.env.E2E_API_URL;
const edition = process.env.E2E_EDITION;
assert.ok(
  api && ["core", "commercial"].includes(edition),
  "E2E_API_URL and E2E_EDITION are required",
);
assert.ok(
  ["127.0.0.1", "localhost"].includes(new URL(api).hostname),
  "E2E must target a local isolated deployment",
);
assert.ok(
  /^\/sourceweft_billing_test/.test(new URL(process.env.DATABASE_URL).pathname),
  "Use the isolated billing test database",
);
const origin = process.env.NEXT_PUBLIC_WEB_BASE_URL || "http://127.0.0.1:3412";
const password = "Billing-E2E-only-2026!";
const id = randomUUID().replaceAll("-", "");
const checks = [];
async function request(
  route,
  { method = "GET", body, cookie = "", status = 200 } = {},
) {
  const response = await fetch(api + route, {
    method,
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    status,
    `${method} ${route}: ${data.code || data.message || "unexpected status"}`,
  );
  return {
    data,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; "),
  };
}
for (let i = 0; i < 60; i++) {
  try {
    const response = await fetch(api + "/v1/health", {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) break;
  } catch {}
  if (i === 59) throw new Error("API did not become ready");
  await delay(500);
}
const caps = (await request("/v1/deployment/capabilities")).data;
assert.equal(caps.edition, edition);
assert.equal(caps.billing.available, edition === "commercial");
checks.push("deployment capabilities");
await request("/v1/teams/unknown/billing/summary", { status: 401 });
checks.push("unauthenticated billing rejected");
async function signup(suffix) {
  const result = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: {
      email: `billing-${id}-${suffix}@example.invalid`,
      name: `Billing E2E ${suffix}`,
      password,
    },
  });
  assert.ok(result.cookie, "Signup must establish a session");
  assert.ok(result.data.user?.id);
  return {
    cookie: result.cookie,
    userId: result.data.user.id,
    email: `billing-${id}-${suffix}@example.invalid`,
  };
}
const owner = await signup("owner");
checks.push("signup and session");
const orgs = (await request("/api/auth/organization/list", owner)).data;
assert.ok(orgs.length > 0, "Personal organization provisioned");
const personal = orgs[0];
const workspaces = (await request(`/v1/teams/${personal.id}/workspaces`, owner))
  .data;
assert.ok(workspaces.items.length > 0, "Personal workspace provisioned");
checks.push("personal workspace provisioning");
const team = (
  await request("/api/auth/organization/create", {
    ...owner,
    method: "POST",
    body: {
      name: "Billing E2E Team",
      slug: `billing-${id}`,
      metadata: { sourceweft: { kind: "team" } },
    },
  })
).data;
assert.ok(team.id);
checks.push("team creation without checkout");
const teamWorkspaces = (await request(`/v1/teams/${team.id}/workspaces`, owner))
  .data;
assert.ok(teamWorkspaces.items.length > 0);
checks.push("team workspace provisioning");
const outsider = await signup("outsider");
await request(`/v1/teams/${team.id}/workspaces`, { ...outsider, status: 403 });
checks.push("cross-tenant access rejected");
const summary = await request(`/v1/teams/${personal.id}/billing/summary`, {
  ...owner,
  status: edition === "core" ? 501 : 200,
});
if (edition === "core") assert.equal(summary.data.code, "BILLING_UNAVAILABLE");
else assert.ok(summary.data.credits.monthlyGrant > 0);
checks.push("edition-specific billing response");
const require = createRequire(
  new URL("../../apps/backend/package.json", import.meta.url),
);
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const rows = await pool.query(
    "select count(*)::int as count from billing_accounts where user_id=$1",
    [owner.userId],
  );
  if (edition === "core")
    assert.equal(
      rows.rows[0].count,
      0,
      "Core must not create commercial billing accounts",
    );
  else assert.ok(rows.rows[0].count > 0);
  checks.push("actual account persistence boundary");
} finally {
  await pool.end();
}
console.log(
  JSON.stringify(
    { edition, ownerEmail: owner.email, checks, passed: checks.length },
    null,
    2,
  ),
);
