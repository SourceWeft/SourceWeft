import { OrganizationView } from "@daveyplate/better-auth-ui";
import { organizationStaticPaths } from "../../../lib/auth-ui-config";

export const dynamicParams = false;

export function generateStaticParams() {
  return organizationStaticPaths.map((path) => ({ path }));
}

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <main className="container p-4 md:p-6">
      <OrganizationView path={path} />
    </main>
  );
}
