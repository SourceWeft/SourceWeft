import { config } from "../../../../shared/config";

type Pdf2MarkdownErrorBody = {
  error?: {
    code?: string;
    message?: string;
  };
};

export type Pdf2MarkdownTaskStatus = {
  task_id: string;
  status: string;
  filename?: string;
  page_count?: number;
  credits_charged?: number;
  created_at?: string;
  updated_at?: string;
};

export type Pdf2MarkdownTaskResult = Pdf2MarkdownTaskStatus & {
  completed_at?: string;
  result?: {
    url?: string;
    expires_at?: number;
  };
};

function requireApiKey() {
  if (!config.pdf2markdown.apiKey) {
    throw new Error(
      "PDF2Markdown provider is not configured: PDF2MARKDOWN_API_KEY is missing",
    );
  }

  return config.pdf2markdown.apiKey;
}

async function parseError(response: Response) {
  const body = (await response
    .json()
    .catch(() => null)) as Pdf2MarkdownErrorBody | null;
  const code = body?.error?.code ?? `http_${response.status}`;
  const message = body?.error?.message ?? response.statusText;
  return new Error(`PDF2Markdown request failed (${code}): ${message}`);
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.pdf2markdown.requestTimeoutMs,
  );

  try {
    const response = await fetch(`${config.pdf2markdown.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "X-API-Key": requireApiKey(),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw await parseError(response);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function submitPdf2MarkdownAsync(input: {
  content: Buffer;
  filename: string;
  metadata?: Record<string, unknown>;
}) {
  return requestJson<{
    code: string;
    data: {
      task_id: string;
      status: string;
      estimated_credits?: number;
      page_count?: number;
      created_at?: string;
    };
  }>("/v1/parse/async", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base64: input.content.toString("base64"),
      filename: input.filename,
      output: config.pdf2markdown.output,
      metadata: input.metadata,
    }),
  });
}

export function getPdf2MarkdownTaskStatus(taskId: string) {
  return requestJson<Pdf2MarkdownTaskStatus>(
    `/v1/tasks/${encodeURIComponent(taskId)}/status`,
  );
}

export function getPdf2MarkdownTaskResult(taskId: string) {
  return requestJson<Pdf2MarkdownTaskResult>(
    `/v1/tasks/${encodeURIComponent(taskId)}/result`,
  );
}

export async function downloadPdf2MarkdownResult(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.pdf2markdown.requestTimeoutMs,
  );

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `PDF2Markdown result download failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}
