"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { authClient } from "../../../lib/auth-client";

function parseScope(scope: string | null) {
  if (!scope) {
    return [];
  }

  return scope
    .split(" ")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function message(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") {
      return value;
    }
  }

  return "Consent action failed";
}

function ConsentPageContent() {
  const params = useSearchParams();
  const clientId = params.get("client_id");
  const scopes = useMemo(() => parseScope(params.get("scope")), [params]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(accept: boolean) {
    setBusy(true);
    setError(null);

    try {
      const result = await authClient.oauth2.consent({
        accept,
        scope: scopes.join(" "),
      });

      if (result?.error) {
        throw new Error(result.error.message || "Consent failed");
      }
    } catch (value) {
      setError(message(value));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-6">
      <section className="w-full space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">
          Authorization request
        </h1>
        <p className="text-sm text-slate-600">
          {clientId
            ? `Client ${clientId} is requesting access.`
            : "A client is requesting access."}
        </p>

        {scopes.length > 0 && (
          <ul className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            {scopes.map((scope) => (
              <li key={scope}>- {scope}</li>
            ))}
          </ul>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            disabled={busy}
            onClick={() => {
              void submit(true);
            }}
          >
            Allow
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            disabled={busy}
            onClick={() => {
              void submit(false);
            }}
          >
            Deny
          </button>
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

export default function ConsentPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-6">
          <section className="w-full space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-2xl font-semibold text-slate-900">
              Authorization request
            </h1>
            <p className="text-sm text-slate-600">Loading request...</p>
          </section>
        </main>
      }
    >
      <ConsentPageContent />
    </Suspense>
  );
}
