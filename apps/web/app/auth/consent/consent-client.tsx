"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
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

function message(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") {
      return value;
    }
  }

  return fallback;
}

function scopeLabel(scope: string, t: ReturnType<typeof useTranslations>) {
  const key = `scope.${scope}`;
  return t.has(key) ? t(key) : scope;
}

function ConsentPageContent() {
  const t = useTranslations("authPages.consent");
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
        throw new Error(result.error.message || t("consentFailed"));
      }
    } catch (value) {
      setError(message(value, t("consentActionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-6">
      <section className="w-full space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">
          {t("title")}
        </h1>
        <p className="text-sm text-slate-600">
          {clientId
            ? t("clientRequesting", { clientId })
            : t("genericRequesting")}
        </p>

        {scopes.length > 0 && (
          <ul className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            {scopes.map((scope) => (
              <li key={scope}>- {scopeLabel(scope, t)}</li>
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
            {t("allow")}
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            disabled={busy}
            onClick={() => {
              void submit(false);
            }}
          >
            {t("deny")}
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

export function ConsentClient() {
  const t = useTranslations("authPages.consent");
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-6">
          <section className="w-full space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-2xl font-semibold text-slate-900">
              {t("title")}
            </h1>
            <p className="text-sm text-slate-600">{t("loadingRequest")}</p>
          </section>
        </main>
      }
    >
      <ConsentPageContent />
    </Suspense>
  );
}
