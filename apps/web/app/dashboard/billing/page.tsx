import { redirect } from "next/navigation";
import { billingUiAvailable } from "../../../lib/billing-edition/catalog";
import { BillingSuccessClient } from "./billing-success-client";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string; checkout?: string }>;
}) {
  if (!billingUiAvailable) redirect("/dashboard");
  const params = await searchParams;

  return <BillingSuccessClient orderId={params.orderId ?? null} />;
}
