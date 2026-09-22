import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sourceweft/ui-web/components/ui/card";
import { NO_INDEX_METADATA } from "../../seo";
import { AcceptInvitationClient } from "./accept-invitation-client";

export const metadata: Metadata = NO_INDEX_METADATA;

function AcceptInvitationFallback({
  title,
  loading,
}: {
  title: string;
  loading: string;
}) {
  return (
    <Card className="w-full max-w-md rounded-lg border-border/80 shadow-sm">
      <CardHeader className="gap-2 text-center">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{loading}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-20 rounded-lg bg-muted/40" />
      </CardContent>
    </Card>
  );
}

export default async function AcceptInvitationPage() {
  const t = await getTranslations("authPages.acceptInvitation");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center p-6">
      <Suspense
        fallback={
          <AcceptInvitationFallback
            loading={t("loading")}
            title={t("title")}
          />
        }
      >
        <AcceptInvitationClient />
      </Suspense>
    </main>
  );
}
