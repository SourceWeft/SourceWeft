import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

// Only the browser-session lookup is replaced; the native-proof check, the
// device-access rules and the service run for real against PostgreSQL.
const session = vi.hoisted(() => ({
  current: null as null | { userId: string; sessionId: string },
}));
vi.mock("../middleware/auth-session", () => ({
  requireSession: async () =>
    session.current
      ? {
          user: { id: session.current.userId },
          session: { id: session.current.sessionId },
        }
      : null,
}));

let schema: typeof import("@sourceweft/db");
let access: typeof import("../../modules/devices/access");
let service: typeof import("../../modules/devices/service");
let server: Hono;
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const original = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("net_routes");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  access = await import("../../modules/devices/access");
  service = await import("../../modules/devices/service");
  const { registerLocalNetworkRoutes } = await import("./local-network");
  server = new Hono();
  server.onError((error, c) =>
    c.json(
      { code: (error as { code?: string }).code },
      ((error as { statusCode?: number }).statusCode as 400) ?? 500,
    ),
  );
  registerLocalNetworkRoutes(server);
}, 120000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});

async function enrol() {
  const userId = randomUUID(),
    sessionId = randomUUID();
  const { ticket } = await service.createEnrollment(userId, sessionId);
  const device = await service.claimEnrollment(ticket, "Test PC");
  const authTicket = await service.createEnrollment(userId, sessionId);
  const proof = await access.createNativeAccess(
    authTicket.ticket,
    device.token,
    "/Users/test/SourceWeft/task-workspaces",
  );
  return { device, userId, sessionId, proof: proof.proof };
}

const patch = (id: string, body: unknown, proof?: string) =>
  server.request(`/v1/local-devices/${id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(proof ? { "x-local-proof": proof } : {}),
    },
    body: JSON.stringify(body),
  });
const modeOf = async (id: string) =>
  (
    await schema.db.query.localDevices.findFirst({
      where: eq(schema.localDevices.id, id),
    })
  )?.networkMode;

test("the network mode changes only with the computer's own proof, for its own owner", async () => {
  const owner = await enrol();
  const stranger = await enrol();
  const id = owner.device.id;
  session.current = { userId: owner.userId, sessionId: owner.sessionId };

  // A browser session without the proof is not "that computer".
  assert.equal((await patch(id, { networkMode: "ask" })).status, 403);
  // A proof that does not belong to this session or account is refused.
  assert.equal(
    (await patch(id, { networkMode: "ask" }, stranger.proof)).status,
    403,
  );
  session.current = { userId: owner.userId, sessionId: randomUUID() };
  assert.equal(
    (await patch(id, { networkMode: "ask" }, owner.proof)).status,
    403,
  );
  assert.equal(await modeOf(id), "open");

  session.current = { userId: owner.userId, sessionId: owner.sessionId };
  const ok = await patch(id, { networkMode: "strict" }, owner.proof);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.data ?? body, { id, networkMode: "strict" });
  assert.equal(await modeOf(id), "strict");

  // Another account, even with its own valid proof, cannot reach this device.
  session.current = {
    userId: stranger.userId,
    sessionId: stranger.sessionId,
  };
  assert.equal(
    (await patch(id, { networkMode: "ask" }, stranger.proof)).status,
    404,
  );
  // Malformed bodies never reach the service.
  session.current = { userId: owner.userId, sessionId: owner.sessionId };
  assert.equal(
    (await patch(id, { networkMode: "all" }, owner.proof)).status,
    400,
  );
  assert.equal(await modeOf(id), "strict");
  session.current = null;
  assert.equal(
    (await patch(id, { networkMode: "ask" }, owner.proof)).status,
    401,
  );
});
