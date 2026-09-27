"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateUserSettingsRequest } from "@sourceweft/contracts";
import { authClient } from "./auth-client";
import { userSettingsClient } from "./sdk";

export const userSettingsQueryKey = (userId: string | undefined) =>
  ["user-settings", userId ?? null] as const;

/** Shared by appearance sync and preview consumers; never reuse another account's data. */
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

/** UI hint only. Connector manifests and backend execution remain authoritative. */
export function usePreviewFeature(feature: "gmail"): boolean {
  const settings = useUserSettings();
  return (
    !settings.isFetching &&
    !settings.isError &&
    settings.data?.settings.preview?.[feature] === true
  );
}

export function useUpdateUserSettings() {
  const { data: session } = authClient.useSession();
  const client = useQueryClient();
  const userId = session?.user?.id;
  return async (input: UpdateUserSettingsRequest) => {
    const result = await userSettingsClient.updateSettings(input);
    // Refetch instead of retaining a mutation result: simultaneous appearance
    // writes can complete out of order, and preview may have changed meanwhile.
    await client.invalidateQueries({ queryKey: userSettingsQueryKey(userId) });
    return result;
  };
}
