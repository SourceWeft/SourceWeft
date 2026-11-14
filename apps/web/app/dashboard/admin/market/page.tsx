import { redirect } from "next/navigation";

import { legacyMarketTabHref } from "../_components/admin-sections";

/** `/dashboard/admin/market?tab=…` was the address of every Market section. */
export default async function LegacyMarketAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { tab } = await searchParams;
  redirect(legacyMarketTabHref(Array.isArray(tab) ? tab[0] : tab));
}
