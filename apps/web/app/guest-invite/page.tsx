import { Suspense } from "react";
import type { Metadata } from "next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sourceweft/ui-web/components/ui/card";
import { NO_INDEX_METADATA } from "../seo";
import { GuestInviteClient } from "./guest-invite-client";

export const metadata: Metadata = NO_INDEX_METADATA;

function GuestInviteFallback() {
  return (
    <Card className="w-full max-w-md rounded-lg border-border/80 shadow-sm">
      <CardHeader className="gap-2 text-center">
        <CardTitle className="text-lg">Guest invitation</CardTitle>
        <CardDescription>Loading invitation...</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-20 rounded-lg bg-muted/40" />
      </CardContent>
    </Card>
  );
}

export default function GuestInvitePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center p-6">
      <Suspense fallback={<GuestInviteFallback />}>
        <GuestInviteClient />
      </Suspense>
    </main>
  );
}
