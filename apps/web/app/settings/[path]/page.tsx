import type { Metadata } from "next";
import { Settings } from "../../_components/auth/settings/settings";
import { settingsStaticPaths } from "../../../lib/auth-ui-config";
import { NO_INDEX_METADATA } from "../../seo";

export const dynamicParams = false;
export const metadata: Metadata = NO_INDEX_METADATA;

export function generateStaticParams() {
  return settingsStaticPaths.map((path) => ({ path }));
}

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <main className="container p-4 md:p-6">
      <Settings path={path} />
    </main>
  );
}
