"use client";

import {
  AuthLoading,
  RedirectToSignIn,
  SignedIn,
} from "@daveyplate/better-auth-ui";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <RedirectToSignIn />
      <AuthLoading>
        <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center p-8 text-sm text-zinc-500">
          Loading session...
        </main>
      </AuthLoading>
      <SignedIn>{children}</SignedIn>
    </>
  );
}
