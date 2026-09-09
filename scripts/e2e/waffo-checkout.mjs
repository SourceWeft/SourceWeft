import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
assert.ok(["create", "verify"].includes(mode), "Use create or verify");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const recordPath = path.join(root, "output/e2e/waffo-checkout-session.json");
const api = process.env.WAFFO_E2E_API_URL || "http://127.0.0.1:3541";
const web = process.env.NEXT_PUBLIC_WEB_BASE_URL || "http://127.0.0.1:3542";
assert.ok(
  ["127.0.0.1", "localhost"].includes(new URL(api).hostname),
  "Only a local test API is permitted",
);
assert.ok(
  ["127.0.0.1", "localhost"].includes(new URL(web).hostname),
  "Only a local test Web origin is permitted",
);
async function request(route, { method = "GET", body, cookie = "" } = {}) {
  const response = await fetch(api + route, {
    method,
    headers: {
      "content-type": "application/json",
      origin: web,
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    200,
    `${route} failed: ${data.code || data.message || response.status}`,
  );
  return {
    data,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
  };
}
const capabilities = (await request("/v1/deployment/capabilities")).data;
assert.equal(capabilities.edition, "commercial");
assert.equal(capabilities.billing.provider, "waffo");
assert.equal(capabilities.billing.paymentEnvironment, "test");
assert.equal(capabilities.billing.topup, true);
if (mode === "create") {
  const email = `waffo-e2e-${randomUUID()}@example.invalid`;
  const password = `Waffo-test-${randomUUID()}!`;
  const user = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password, name: "Waffo payment test" },
  });
  assert.ok(user.cookie);
  const organizations = (
    await request("/api/auth/organization/list", { cookie: user.cookie })
  ).data;
  assert.ok(
    organizations[0]?.id,
    "Personal test organization must be provisioned",
  );
  const teamId = organizations[0].id;
  const order = (
    await request(`/v1/teams/${teamId}/billing/topups/checkout`, {
      method: "POST",
      cookie: user.cookie,
      body: {
        unitType: "page",
        quantity: 1,
        clientReferenceKey: `waffo-live-test:${randomUUID()}`,
      },
    })
  ).data;
  assert.equal(order.provider, "waffo");
  const record = {
    environment: "test",
    api,
    web,
    email,
    password,
    cookie: user.cookie,
    userId: user.data.user.id,
    teamId,
    orderId: order.orderId,
    checkoutUrl: order.checkoutUrl,
  };
  await mkdir(path.dirname(recordPath), { recursive: true, mode: 0o700 });
  await writeFile(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        orderId: order.orderId,
        checkoutUrl: order.checkoutUrl,
        sessionFile: recordPath,
        testCard: "4576750000000110",
      },
      null,
      2,
    ),
  );
} else {
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.environment, "test");
  assert.equal(record.api, api);
  const order = (
    await request(`/v1/billing/orders/${record.orderId}`, {
      cookie: record.cookie,
    })
  ).data;
  assert.equal(order.provider, "waffo");
  assert.equal(order.paymentStatus, "paid");
  assert.equal(order.status, "fulfilled");
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(
    databaseUrl &&
      /^\/sourceweft_billing_test/.test(new URL(databaseUrl).pathname),
    "Use the isolated billing test database",
  );
  assert.ok(
    ["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname),
    "Only a local test database is permitted",
  );
  const require = createRequire(path.join(root, "apps/backend/package.json"));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const receipts = await pool.query(
      "select id,event_type,status,payload->>'mode' as mode from billing_webhook_events where provider='waffo' and event_type='order.completed' and payload->'data'->>'orderMerchantExternalId'=$1",
      [record.orderId],
    );
    assert.ok(
      receipts.rows.some(
        (row) => row.status === "processed" && row.mode === "test",
      ),
      "A genuine processed order.completed receipt is required",
    );
    const grants = await pool.query(
      "select count(*)::int as n from usage_ledgers where team_id=$1 and reference_id=$2 and operation_type='topup'",
      [record.teamId, record.orderId],
    );
    assert.equal(
      grants.rows[0].n,
      1,
      "Exactly one entitlement grant is required",
    );
    const result = {
      orderId: record.orderId,
      provider: "waffo",
      environment: "test",
      paymentStatus: order.paymentStatus,
      status: order.status,
      webhookReceipts: receipts.rows,
      grantCount: grants.rows[0].n,
    };
    await writeFile(
      path.join(path.dirname(recordPath), "waffo-checkout-result.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}
