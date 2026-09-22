"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error-diagnostics";

// The root layout and its translation/theme providers may themselves have failed.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => reportClientError(error, "global"), [error]);
  return (
    <html lang="en">
      <head>
        <title>SourceWeft — Unable to display page</title>
      </head>
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          padding: "3rem",
          textAlign: "center",
        }}
      >
        <main role="alert">
          <h1>Unable to display this page</h1>
          <p lang="zh-CN">页面显示异常，请重试。</p>
          <button type="button" onClick={retry}>
            Try again / 重试
          </button>
        </main>
      </body>
    </html>
  );
}
