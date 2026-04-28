export type ErrorDetail = {
  name: string;
  message: string;
  stack?: string;
  status?: number;
  statusText?: string;
  url?: string;
  bodyCode?: string;
  bodyMessage?: string;
};

export function describeError(error: unknown): ErrorDetail {
  const asRecord =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;

  if (asRecord) {
    const body =
      asRecord.body && typeof asRecord.body === "object"
        ? (asRecord.body as Record<string, unknown>)
        : undefined;

    const status =
      typeof asRecord.status === "number"
        ? asRecord.status
        : typeof asRecord.statusCode === "number"
          ? asRecord.statusCode
          : undefined;

    const messageFromBody =
      body && typeof body.message === "string" ? body.message : undefined;

    const codeFromBody =
      body && typeof body.code === "string" ? body.code : undefined;

    const errorStack =
      typeof asRecord.errorStack === "string" ? asRecord.errorStack : undefined;

    if (
      typeof asRecord.name === "string" &&
      (status !== undefined || body || errorStack)
    ) {
      return {
        name: asRecord.name,
        message:
          typeof asRecord.message === "string" && asRecord.message
            ? asRecord.message
            : messageFromBody || "",
        stack:
          typeof asRecord.stack === "string" && asRecord.stack
            ? asRecord.stack
            : errorStack,
        status,
        bodyCode: codeFromBody,
        bodyMessage: messageFromBody,
      };
    }
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (typeof Response !== "undefined" && error instanceof Response) {
    return {
      name: "Response",
      message: `${error.status} ${error.statusText}`,
      status: error.status,
      statusText: error.statusText,
      url: error.url,
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: error,
    };
  }

  return {
    name: "UnknownError",
    message: "Non-Error throw",
  };
}
