import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { BillingStore } from "./store-port";
import type { TeamSubscriptionSnapshot } from "./types";
import {
  normalizeSubscriptionFact,
  subscriptionIdentity,
} from "./subscription-policy";

export async function prepareSubscriptionFact(
  store: BillingStore,
  input: TeamSubscriptionSnapshot,
  client: PoolClient,
  establish = false,
) {
  await store.lockSubscriptionTarget(`team:${input.teamId}`, client);
  const current = await store.getSubscriptionByTeam(input.teamId, client);
  const identity = subscriptionIdentity(input);
  const binding = await store.getSubscriptionBinding(identity, client);
  // A historical identity can never become current again, including via order retries.
  if (binding && current?.currentBindingId !== binding.id) return null;
  const snapshot = normalizeSubscriptionFact(current, input, establish);
  if (!snapshot) return null;
  snapshot.currentBindingId =
    binding?.id ?? snapshot.currentBindingId ?? randomUUID();
  snapshot.metadata.subscriptionBindingId = snapshot.currentBindingId;
  if (!binding)
    await store.insertSubscriptionBinding(
      {
        id: snapshot.currentBindingId,
        identity,
        teamId: input.teamId,
        provider: input.provider,
        externalSubscriptionId: input.externalSubscriptionId,
        orderId: input.billingOrderId ?? null,
      },
      client,
    );
  return snapshot;
}
