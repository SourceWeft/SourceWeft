import { AccountView } from "@daveyplate/better-auth-ui";
import type { Metadata } from "next";
import { accountStaticPaths } from "../../../lib/auth-ui-config";
import { NO_INDEX_METADATA } from "../../seo";

export const dynamicParams = false;
export const metadata: Metadata = NO_INDEX_METADATA;

export function generateStaticParams() {
  return accountStaticPaths.map((path) => ({ path }));
}

export default async function AccountPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <main className="container p-4 md:p-6">
      <AccountView path={path} />
    </main>
  );
}
