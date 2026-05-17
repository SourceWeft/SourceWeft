import Link from "next/link";
import type { Metadata } from "next";

import { NO_INDEX_METADATA } from "../../seo";

export const metadata: Metadata = NO_INDEX_METADATA;

type SearchParams = Record<string, string | string[] | undefined>;

function pickFirst(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] || "";
  }

  return value || "";
}

function resolveErrorCode(searchParams: SearchParams) {
  const code =
    pickFirst(searchParams.error) ||
    pickFirst(searchParams.code) ||
    "authentication_error";

  return code;
}

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const code = resolveErrorCode(resolvedSearchParams);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-6">
      <section className="w-full space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Sign-in error</h1>
        <p className="text-sm text-slate-600">
          Authentication failed. Please try again, or contact support with the
          error code below.
        </p>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Error code: <span className="font-medium">{code}</span>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Link
            href="/auth/sign-in"
            className="rounded-lg bg-slate-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-slate-800"
          >
            Try again
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-slate-300 px-4 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Go home
          </Link>
        </div>
      </section>
    </main>
  );
}
