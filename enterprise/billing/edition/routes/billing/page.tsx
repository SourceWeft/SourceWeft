// Generated commercial billing route; subject to enterprise/LICENSE.
import { BillingSuccessClient } from "../../../lib/billing-edition/client";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string; checkout?: string }>;
}) {
  const params = await searchParams;

  return <BillingSuccessClient orderId={params.orderId ?? null} />;
}
