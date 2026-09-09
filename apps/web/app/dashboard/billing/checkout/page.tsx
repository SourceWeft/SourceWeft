import { redirect } from "next/navigation";
import { billingUiAvailable } from "../../../../lib/billing-edition/catalog";
import { BillingCheckoutClient } from "./billing-checkout-client";

type CheckoutSearchParams = {
  billingInterval?: string;
  intent?: string;
  plan?: string;
  seatCount?: string;
  source?: string;
  teamName?: string;
};

export default async function BillingCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<CheckoutSearchParams>;
}) {
  if (!billingUiAvailable) redirect("/dashboard");
  const params = await searchParams;

  return (
    <BillingCheckoutClient
      billingInterval={params.billingInterval ?? null}
      intent={params.intent ?? null}
      plan={params.plan ?? null}
      seatCount={params.seatCount ?? null}
      source={params.source ?? null}
      teamName={params.teamName ?? null}
    />
  );
}
