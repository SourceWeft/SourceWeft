import { BillingSuccessClient } from "./billing-success-client";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string; checkout?: string }>;
}) {
  const params = await searchParams;

  return <BillingSuccessClient orderId={params.orderId ?? null} />;
}
