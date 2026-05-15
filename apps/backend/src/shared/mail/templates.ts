import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToText } from "html-to-text";

type TemplateMetadata = {
  action?: string;
  heading?: string;
  preview?: string;
  subject?: string;
  url?: string;
};

export type MailTemplateVariables = Record<string, unknown>;

export type RenderedMailTemplate = {
  subject: string;
  html: string;
  text: string;
};

const templatesDir = fileURLToPath(new URL("./templates/", import.meta.url));

function assertTemplateId(templateId: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(templateId)) {
    throw new Error(`Invalid mail template id: ${templateId}`);
  }
}

function readTemplateFile(filename: string) {
  return readFileSync(join(templatesDir, filename), "utf8");
}

function parseTemplateFile(raw: string) {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const metadataBlock = match?.[1];
  const body = match?.[2];
  if (!metadataBlock || body === undefined) {
    throw new Error("Mail template must start with frontmatter");
  }

  const metadata: TemplateMetadata = {};
  for (const line of metadataBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new Error(`Invalid mail template metadata line: ${line}`);
    }

    const key = trimmed.slice(0, separator).trim() as keyof TemplateMetadata;
    const value = trimmed.slice(separator + 1).trim();
    metadata[key] = value;
  }

  if (!metadata.subject) {
    throw new Error("Mail template metadata requires subject");
  }

  return {
    body: body.trim(),
    metadata,
  };
}

function stringifyValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function escapeHtml(value: unknown) {
  return stringifyValue(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lookupVariable(
  variables: MailTemplateVariables,
  key: string,
  fallback: MailTemplateVariables = {},
) {
  if (Object.prototype.hasOwnProperty.call(variables, key)) {
    return variables[key];
  }
  if (Object.prototype.hasOwnProperty.call(fallback, key)) {
    return fallback[key];
  }
  return "";
}

function isTruthy(value: unknown) {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function resolveConditionBlocks(
  template: string,
  variables: MailTemplateVariables,
  fallback: MailTemplateVariables = {},
) {
  return template.replace(
    /\{\{\#if\s+([a-zA-Z0-9_.-]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key: string, content: string) =>
      isTruthy(lookupVariable(variables, key, fallback)) ? content : "",
  );
}

function interpolateEscaped(
  template: string,
  variables: MailTemplateVariables,
  fallback: MailTemplateVariables = {},
) {
  return resolveConditionBlocks(template, variables, fallback)
    .replace(/\{\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}\}/g, (_, key: string) =>
      stringifyValue(lookupVariable(variables, key, fallback)),
    )
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) =>
      escapeHtml(lookupVariable(variables, key, fallback)),
    );
}

function interpolateRaw(
  template: string | undefined,
  variables: MailTemplateVariables,
) {
  return (template ?? "").replace(
    /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (_, key: string) => stringifyValue(lookupVariable(variables, key)),
  );
}

function resolveBaseUrl(variables: MailTemplateVariables) {
  return (
    stringifyValue(variables.baseUrl).trim() ||
    process.env.NEXT_PUBLIC_WEB_BASE_URL?.trim() ||
    process.env.BASE_URL?.trim() ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function resolveImageUrl(baseUrl: string, variables: MailTemplateVariables) {
  const configured = stringifyValue(variables.imageUrl).trim();
  if (configured) {
    return configured;
  }

  return `${baseUrl}/icon-512.png`;
}

function buildActionHtml(action: string, url: string) {
  if (!action || !url) {
    return "";
  }

  return [
    '<div class="action">',
    `<a class="button" href="${escapeHtml(url)}">${escapeHtml(action)}</a>`,
    "</div>",
  ].join("");
}

export function renderMailTemplate(
  templateId: string,
  variables: MailTemplateVariables = {},
): RenderedMailTemplate {
  assertTemplateId(templateId);

  const template = parseTemplateFile(readTemplateFile(`${templateId}.html`));
  const baseUrl = resolveBaseUrl(variables);
  const subject = interpolateRaw(template.metadata.subject, variables);
  const heading = interpolateRaw(template.metadata.heading, variables) || subject;
  const preview = interpolateRaw(template.metadata.preview, variables);
  const action = interpolateRaw(template.metadata.action, variables);
  const url = interpolateRaw(template.metadata.url, variables);
  const bodyHtml = interpolateEscaped(template.body, variables);
  const layoutHtml = interpolateEscaped(readTemplateFile("layout.html"), {
    actionHtml: buildActionHtml(action, url),
    baseUrl,
    baseUrlLabel: baseUrl.replace(/^https?:\/\//, ""),
    bodyHtml,
    heading,
    imageUrl: resolveImageUrl(baseUrl, variables),
    preview,
    siteName: "SourceWeft",
    subject,
  });
  const text = htmlToText(layoutHtml, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "[data-mail-preview]", format: "skip" },
    ],
  });

  return {
    subject,
    html: layoutHtml,
    text,
  };
}
