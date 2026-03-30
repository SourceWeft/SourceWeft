import { AccountView } from "@daveyplate/better-auth-ui";
import { accountStaticPaths } from "../../../lib/auth-ui-config";

export const dynamicParams = false;

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
