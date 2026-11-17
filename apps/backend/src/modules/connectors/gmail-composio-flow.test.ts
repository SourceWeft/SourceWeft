import { beforeEach, expect, it, vi } from "vitest";

// One end-to-end pass of the Composio-brokered Gmail connector: the REAL
// composio-mode adapter and a fake broker, registered in a real
// ConnectorRegistry, driven through a real ConnectorOAuthService with only the
// persistence/secret/permission collaborators mocked (same style as
// oauth-brokered.test.ts). Every hop a stand-in test only checks in isolation
// is exercised here against its real neighbour.

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  requireAvailable: vi.fn(),
  createState: vi.fn(),
  consume: vi.fn(),
  createAccount: vi.fn(),
  findAccount: vi.fn(),
  findReauthorizable: vi.fn(),
  reauthorize: vi.fn(),
}));

vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.workspace,
}));
vi.mock("../../shared/config", () => ({
  config: { auth: { baseUrl: "https://api.sourceweft.test" } },
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: vi.fn(async (value: string) => `enc(${value})`),
  decryptTeamSecret: vi.fn(async (value: string) =>
    value.startsWith("enc(") ? value.slice(4, -1) : value,
  ),
}));
vi.mock("./repository", () => ({
  consumeOAuthStateRecord: mocks.consume,
  createOAuthAccountRecord: mocks.createAccount,
  createOAuthStateRecord: mocks.createState,
  findOAuthAccountRecord: mocks.findAccount,
  findReauthorizableOAuthAccountRecord: mocks.findReauthorizable,
  reauthorizeOAuthAccountRecord: mocks.reauthorize,
}));

import {
  createGmailConnectorAdapter,
  GMAIL_SEND_SCOPE,
} from "@sourceweft/builtin-connector-gmail";
import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorRegistry } from "./registry";

const ISSUED_ID = "ca_issued";

// The Composio broker shapes, declared locally: the backend package does not
// depend on `@sourceweft/connector-broker-composio`, and the fake only needs
// to be structurally compatible with the adapter's broker parameter (cast at
// the `createGmailConnectorAdapter` boundary below).
type FakeProxyInput = {
  connectedAccountId: string;
  ownerRef: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
};
type FakeProxyResult = {
  status: number;
  data: unknown;
  headers: Record<string, string>;
};

/** A Gmail-API fixture for every URL the search action builds. */
function gmailProxyResponse(url: string): FakeProxyResult {
  if (url.includes("/profile")) {
    return {
      status: 200,
      data: { emailAddress: "reader@example.com", historyId: "100" },
      headers: {},
    };
  }
  if (url.includes("/messages/")) {
    return {
      status: 200,
      data: {
        id: "msg_123",
        threadId: "thread_123",
        labelIds: ["INBOX"],
        internalDate: "1770000000000",
        snippet: "A short snippet",
        payload: {
          headers: [
            { name: "Subject", value: "A topic" },
            { name: "From", value: "Author <author@example.com>" },
            { name: "To", value: "reader@example.com" },
          ],
          parts: [],
        },
      },
      headers: {},
    };
  }
  if (url.includes("/messages")) {
    return {
      status: 200,
      data: { messages: [{ id: "msg_123", threadId: "thread_123" }] },
      headers: {},
    };
  }
  return { status: 404, data: {}, headers: {} };
}

function makeBroker() {
  const createLinkCalls: Array<{
    ownerRef: string;
    toolkit: string;
    scopes: string[];
  }> = [];
  const getAccountCalls: string[] = [];
  const proxyCalls: FakeProxyInput[] = [];
  const deleteCalls: string[] = [];
  const broker = {
    async createLink(input: {
      ownerRef: string;
      toolkit: string;
      callbackUrl: string;
      scopes: string[];
    }) {
      createLinkCalls.push(input);
      return {
        authorizationUrl: "https://composio.example/authorize/abc",
        connectedAccountId: ISSUED_ID,
      };
    },
    async getConnectedAccount(id: string) {
      getAccountCalls.push(id);
      return { id, status: "ACTIVE", toolkit: "gmail" };
    },
    async deleteConnectedAccount(id: string) {
      deleteCalls.push(id);
    },
    async proxy(input: FakeProxyInput) {
      proxyCalls.push(input);
      return gmailProxyResponse(input.url);
    },
  };
  return { broker, createLinkCalls, getAccountCalls, proxyCalls, deleteCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.requireAvailable.mockResolvedValue(undefined);
  mocks.createState.mockResolvedValue({ id: "state-row" });
  mocks.findReauthorizable.mockResolvedValue(null);
  mocks.createAccount.mockImplementation(async (input: { scopes: string[] }) => ({
    id: "account_1",
    ...input,
  }));
});

it("drives connect, callback, runtime token, a search action, and revoke through the real service and adapter", async () => {
  const { broker, createLinkCalls, proxyCalls, deleteCalls } = makeBroker();
  const adapter = createGmailConnectorAdapter({
    mode: "composio",
    baseUrl: "https://sourceweft.example",
    broker: broker as never,
  });
  const registry = new ConnectorRegistry([adapter as never]);
  const service = new ConnectorOAuthService(registry, {
    requireAvailable: mocks.requireAvailable,
  } as never);

  // 1. start — the broker opens a link for the gmail toolkit with our owner ref.
  const started = await service.start({
    workspaceId: "workspace",
    userId: "user",
    connectorType: "gmail",
  });
  expect(started.authorizationUrl).toBe("https://composio.example/authorize/abc");
  expect(createLinkCalls).toHaveLength(1);
  expect(createLinkCalls[0]?.ownerRef).toBe("ws_workspace");
  expect(createLinkCalls[0]?.toolkit).toBe("gmail");
  expect(createLinkCalls[0]?.scopes).toEqual(["https://mail.google.com/"]);
  const issuedAttemptRef = mocks.createState.mock.calls[0]?.[0]?.attemptRef;
  expect(issuedAttemptRef).toBe(ISSUED_ID);

  // 2. callback — Composio redirects back with success and the issued id.
  mocks.consume.mockResolvedValue({
    workspaceId: "workspace",
    teamId: "team",
    userId: "user",
    connectorType: "gmail",
    redirectAfter: null,
    attemptRef: issuedAttemptRef,
  });
  const finished = await service.finishGlobalCallback({
    connectorType: "gmail",
    state: "state",
    callbackParams: { status: "success", connected_account_id: ISSUED_ID },
  });
  expect(finished.account.id).toBe("account_1");

  // The stored credential is encrypted, and its scopes include the send scope.
  const storeArgs = mocks.createAccount.mock.calls[0]?.[0];
  const storedCredentialEncrypted: string = storeArgs.accessTokenEncrypted;
  expect(storedCredentialEncrypted.startsWith("enc(")).toBe(true);
  expect(storeArgs.scopes).toContain(GMAIL_SEND_SCOPE);

  // 3. runtime token — the stored (encrypted) credential is handed back decrypted.
  mocks.findAccount.mockResolvedValue({
    id: "account_1",
    teamId: "team",
    workspaceId: "workspace",
    connectorType: "gmail",
    status: "active",
    expiresAt: null,
    scopes: storeArgs.scopes,
    accessTokenEncrypted: storedCredentialEncrypted,
    refreshTokenEncrypted: null,
  });
  const runtimeToken = await service.getRuntimeToken({
    teamId: "team",
    workspaceId: "workspace",
    accountId: "account_1",
    connectorType: "gmail",
  });

  // 4. one search action through the adapter with that runtime token.
  const result = await adapter.executeAction({
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "gmail",
    config: { liveSearchEnabled: true },
    accessToken: runtimeToken,
    actionType: "gmail.message.search",
    request: { query: "from:author@example.com" },
    idempotencyKey: "search",
  });
  const searchResult = result.result as { messages: unknown[] };
  expect(searchResult.messages.length).toBeGreaterThan(0);

  // 5. revoke — deletes the same connected account id that was issued.
  await service.revokeStoredAuthorization({
    id: "account_1",
    teamId: "team",
    workspaceId: "workspace",
    connectorType: "gmail",
    accessTokenEncrypted: storedCredentialEncrypted,
    refreshTokenEncrypted: null,
  } as never);
  expect(deleteCalls).toEqual([ISSUED_ID]);

  // Hop-to-hop invariants: every broker proxy call carries our owner ref and
  // only ever targets an absolute Gmail API URL under users/me.
  expect(proxyCalls.length).toBeGreaterThan(0);
  for (const call of proxyCalls) {
    expect(call.ownerRef).toBe("ws_workspace");
    expect(call.url).toMatch(
      /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\//,
    );
  }
});
