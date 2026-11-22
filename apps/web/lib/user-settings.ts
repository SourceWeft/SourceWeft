"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateUserSettingsRequest } from "@sourceweft/contracts";
import { authClient } from "./auth-client";
import { userSettingsClient } from "./sdk";

export const userSettingsQueryKey = (userId: string | undefined) =>
  ["user-settings", userId ?? null] as const;

/** Shared by appearance sync and the account settings panel; never reuse another account's data. */
export function useUserSettings() {
  const { data: session, isPending } = authClient.useSession();
  const userId = isPending ? undefined : session?.user?.id;
  const query = useQuery({
    queryKey: userSettingsQueryKey(userId),
    queryFn: () => userSettingsClient.getSettings(),
    enabled: Boolean(userId),
    staleTime: 5_000,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: "always",
  });
  return { ...query, data: userId ? query.data : undefined };
}

export function useUpdateUserSettings() {
  const { data: session } = authClient.useSession();
  const client = useQueryClient();
  const userId = session?.user?.id;
  return async (input: UpdateUserSettingsRequest) => {
    const result = await userSettingsClient.updateSettings(input);
    // Refetch instead of retaining a mutation result: simultaneous appearance
    // writes can complete out of order.
    await client.invalidateQueries({ queryKey: userSettingsQueryKey(userId) });
    return result;
  };
}
