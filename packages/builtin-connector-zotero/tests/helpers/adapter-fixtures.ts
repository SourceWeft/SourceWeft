import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { createZoteroAdapter } from "../../src/adapter";
import {
  startFakeZotero,
  type FakeLibrary,
  type FakeObject,
  type FakeZotero,
} from "./fake-zotero";

export const API_KEY = "abcdEFGH12345678abcdEFGH";

export const rawCollection = (
  key: string,
  name: string,
  parent: string | false = false,
): FakeObject => ({
  key,
  version: 1,
  data: { key, name, parentCollection: parent },
});

export const rawItem = (
  key: string,
  itemType: string,
  data: Record<string, unknown> = {},
): FakeObject => ({
  key,
  version: 1,
  data: { key, version: 1, itemType, ...data },
});

export const storedCredential = (
  username = "users/1",
  secret = API_KEY,
): string => JSON.stringify({ username, secret });

export const userConfig = (
  items: Array<{ id: string; kind: string }> = [],
): Record<string, unknown> => ({
  libraryType: "user",
  libraryId: "1",
  items,
});

export const keyInfo = (overrides: {
  userID?: number;
  user?: Record<string, unknown> | null;
  groups?: Record<string, unknown>;
}): Record<string, unknown> => ({
  key: "fake",
  userID: overrides.userID ?? 1,
  username: "alice",
  access: {
    ...(overrides.user === null
      ? {}
      : { user: overrides.user ?? { library: true, notes: true } }),
    groups: overrides.groups ?? {},
  },
});

export type Harness = {
  fake: FakeZotero;
  /** Number of scopes opened and closed. */
  opened: () => number;
  closed: () => number;
  adapter: ReturnType<typeof createZoteroAdapter>;
};

export function harness(
  library: FakeLibrary,
  options: {
    limits?: Parameters<typeof createZoteroAdapter>[0]["limits"];
  } = {},
): Harness {
  const fake = startFakeZotero({ version: 5, ...library });
  let opened = 0;
  let closed = 0;
  const credentialedFetch = (): ConnectorPublicFetchScope => {
    opened += 1;
    return {
      fetch: fake.fetch,
      close: async () => {
        closed += 1;
      },
    };
  };
  const adapter = createZoteroAdapter({
    credentialedFetch,
    limits: options.limits,
    now: () => 1_700_000_000_000,
  });
  return {
    fake,
    opened: () => opened,
    closed: () => closed,
    adapter,
  };
}

export const baseInput = (
  config: Record<string, unknown> = userConfig(),
  accessToken = storedCredential(),
) => ({
  teamId: "t",
  workspaceId: "w",
  connectorId: "c",
  connectorType: "zotero",
  config,
  accessToken,
});
