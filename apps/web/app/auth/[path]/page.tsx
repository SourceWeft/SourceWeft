import type { Metadata } from "next";
import { authStaticPaths } from "../../../lib/auth-ui-config";
import { NO_INDEX_METADATA } from "../../seo";
import { DesktopAuthListener } from "../desktop-auth-listener";
import { AuthViewClient } from "./auth-view-client";

export const dynamicParams = false;
export const metadata: Metadata = NO_INDEX_METADATA;

export function generateStaticParams() {
  return authStaticPaths.map((path) => ({ path }));
}

export default async function AuthPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <main className="flex min-h-svh w-full items-center justify-center bg-background p-4 md:p-6">
      <DesktopAuthListener />
      <AuthViewClient path={path} />
    </main>
  );
}
