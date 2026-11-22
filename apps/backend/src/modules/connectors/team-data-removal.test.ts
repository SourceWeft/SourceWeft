import { describe, expect, it, vi } from "vitest";

vi.mock("./oauth-service", () => ({ ConnectorOAuthService: vi.fn() }));
vi.mock("./repository", () => ({
  listTeamOAuthAccountSecretRecords: vi.fn(),
  hardDeleteTeamConnectorRecords: vi.fn(),
}));

import { ConnectorError } from "./errors";
import { ConnectorTeamDataRemoval } from "./team-data-removal";
import type { ConnectorOAuthAccountSecretRecord } from "./types";

function account(id: string, teamId: string) {
  return {
    id,
    teamId,
    connectorType: "gmail",
  } as ConnectorOAuthAccountSecretRecord;
}

function setup(
  accountsByTeam: Record<string, ConnectorOAuthAccountSecretRecord[]>,
) {
  const calls: string[] = [];
  const revokeStoredAuthorization = vi.fn(
    async (item: ConnectorOAuthAccountSecretRecord) => {
      calls.push(`revoke:${item.id}`);
    },
  );
  const repository = {
    listTeamOAuthAccountSecretRecords: vi.fn(
      async (teamId: string) => accountsByTeam[teamId] ?? [],
    ),
    hardDeleteTeamConnectorRecords: vi.fn(async (teamId: string) => {
      calls.push(`delete:${teamId}`);
      return {
        connectorsDeleted: 1,
        sourcesDeleted: 2,
        authorizationsDeleted: 1,
      };
    }),
  };
  const removal = new ConnectorTeamDataRemoval(
    { revokeStoredAuthorization },
    repository,
  );
  return { removal, calls, revokeStoredAuthorization, repository };
}

describe("ConnectorTeamDataRemoval", () => {
  it("revokes every authorization of every team before deleting anything", async () => {
    const { removal, calls } = setup({
      "team-a": [account("a1", "team-a"), account("a2", "team-a")],
      "team-b": [account("b1", "team-b")],
    });

    const result = await removal.removeTeams(["team-a", "team-b"]);

    expect(calls).toEqual([
      "revoke:a1",
      "revoke:a2",
      "revoke:b1",
      "delete:team-a",
      "delete:team-b",
    ]);
    expect(result).toEqual([
      {
        teamId: "team-a",
        connectorsDeleted: 1,
        sourcesDeleted: 2,
        authorizationsDeleted: 1,
      },
      {
        teamId: "team-b",
        connectorsDeleted: 1,
        sourcesDeleted: 2,
        authorizationsDeleted: 1,
      },
    ]);
  });

  it("deletes nothing local when a provider revocation fails", async () => {
    const { removal, revokeStoredAuthorization, repository } = setup({
      "team-a": [account("a1", "team-a"), account("a2", "team-a")],
    });
    revokeStoredAuthorization.mockImplementationOnce(async () => {
      throw new ConnectorError(
        502,
        "CONNECTOR_AUTHORIZATION_REVOKE_FAILED",
        "The connection could not be removed at the provider. Try again.",
      );
    });

    await expect(removal.removeTeams(["team-a"])).rejects.toMatchObject({
      code: "CONNECTOR_AUTHORIZATION_REVOKE_FAILED",
    });
    expect(repository.hardDeleteTeamConnectorRecords).not.toHaveBeenCalled();
  });

  it("still deletes a team's connectors when it has no stored authorization", async () => {
    const { removal, calls } = setup({});

    await removal.removeTeams(["team-a", "team-a"]);

    expect(calls).toEqual(["delete:team-a"]);
  });
});
