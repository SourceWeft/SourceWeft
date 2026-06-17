import { config } from "../../../shared/config";
import type {
  MailProvider,
  MailRecipient,
  MailSendInput,
  MailSendResult,
} from "../types";

type PlunkSendResponse = {
  success?: boolean;
  data?: {
    emails?: Array<{
      email?: string;
      contact?: {
        id?: string;
      };
    }>;
    timestamp?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

function normalizeRecipient(recipient: MailRecipient) {
  if (typeof recipient === "string") {
    return recipient;
  }

  if (recipient.name) {
    return {
      name: recipient.name,
      email: recipient.email,
    };
  }

  return recipient.email;
}

function normalizeTo(value: MailRecipient | MailRecipient[]) {
  if (Array.isArray(value)) {
    return value.map(normalizeRecipient);
  }

  return normalizeRecipient(value);
}

function parseRequestId(headers: Headers) {
  return (
    headers.get("x-request-id") ||
    headers.get("request-id") ||
    headers.get("x-plunk-request-id") ||
    undefined
  );
}

export class PlunkApiProvider implements MailProvider {
  async send(input: MailSendInput): Promise<MailSendResult> {
    if (!config.mail.plunkApiKey) {
      throw new Error("PLUNK_API_KEY is required when MAIL_PROVIDER=plunk");
    }

    const endpoint = `${config.mail.plunkApiBaseUrl.replace(/\/$/, "")}/v1/send`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.mail.plunkApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: normalizeTo(input.to),
        from: {
          name: config.mail.fromName,
          email: config.mail.fromAddress,
        },
        subject: input.subject,
        body: input.html,
        data: input.variables,
        headers: {
          "X-App": "sourceweft",
          "X-Mail-Type": input.messageType,
          ...(input.templateId ? { "X-Template-Id": input.templateId } : {}),
        },
      }),
    });

    const payload = (await response
      .json()
      .catch(() => null)) as PlunkSendResponse | null;

    if (!response.ok || !payload?.success) {
      const errorMessage =
        payload?.error?.message ||
        `Plunk send failed with status ${response.status}`;
      throw new Error(errorMessage);
    }

    const messageIds =
      payload.data?.emails
        ?.map((entry) => entry.contact?.id || entry.email || "")
        .filter((value) => value.length > 0) || [];

    return {
      accepted: true,
      provider: "plunk",
      requestId: parseRequestId(response.headers),
      messageIds,
    };
  }
}
