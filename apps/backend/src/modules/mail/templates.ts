import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { htmlToText } from "html-to-text";
import { DEFAULT_LOCALE, getLocaleMeta, isLocale } from "@sourceweft/i18n";
import { resolveBackendRuntimePath } from "../../shared/runtime-paths";

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

const templatesDir = resolveBackendRuntimePath({
  candidates: ["dist/modules/mail/templates", "src/modules/mail/templates"],
  envVar: "MAIL_TEMPLATES_DIR",
  label: "mail templates directory",
});

function assertTemplateId(templateId: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(templateId)) {
    throw new Error(`Invalid mail template id: ${templateId}`);
  }
}

function readTemplateFile(filename: string) {
  return readFileSync(join(templatesDir, filename), "utf8");
}

/**
 * Picks the `<id>.<locale>.html` template variant when one exists for a
 * supported non-default locale, else the English `<id>.html` (design §16.7).
 * Reports the language actually resolved so `<html lang>` matches the rendered
 * copy even when a locale falls back to English.
 */
function resolveTemplate(templateId: string, locale?: string) {
  if (locale && locale !== DEFAULT_LOCALE && isLocale(locale)) {
    const variant = `${templateId}.${locale}.html`;
    if (existsSync(join(templatesDir, variant))) {
      return { filename: variant, effectiveLocale: locale };
    }
  }
  return { filename: `${templateId}.html`, effectiveLocale: DEFAULT_LOCALE };
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
  const resolved =
    stringifyValue(variables.baseUrl).trim() ||
    process.env.PUBLIC_WEB_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_WEB_BASE_URL?.trim() ||
    process.env.BASE_URL?.trim();
  if (resolved) {
    return resolved.replace(/\/$/, "");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Cannot send mail in production without a configured base URL. " +
        "Set PUBLIC_WEB_BASE_URL or pass variables.baseUrl.",
    );
  }

  return "http://localhost:3000";
}

function resolveImageUrl(baseUrl: string, variables: MailTemplateVariables) {
  const configured = stringifyValue(variables.imageUrl).trim();
  if (configured) {
    return configured;
  }

  return `${baseUrl}/icon-512.png`;
}

function buildActionHtml(action: string, url: string, locale: string) {
  if (!action || !url) {
    return "";
  }

  const backupLabel =
    locale === "zh-CN"
      ? "按钮无法打开？复制以下链接到浏览器："
      : locale === "zh-TW"
        ? "按鈕無法開啟？複製以下連結到瀏覽器："
        : "Button not working? Copy this link into your browser:";
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 20px;"><tr>',
    '<td class="button-cell" bgcolor="#111827" style="background:#111827;border-radius:6px;text-align:center;mso-padding-alt:14px 24px;">',
    `<a class="button" href="${escapeHtml(url)}" style="display:inline-block;background:#111827;border:1px solid #111827;border-radius:6px;color:#ffffff;font-size:15px;font-weight:600;line-height:22px;padding:14px 24px;text-decoration:none;mso-padding-alt:0;">${escapeHtml(action)}</a>`,
    "</td></tr></table>",
    `<p class="muted" style="margin:0 0 8px;color:#6b7280;font-size:12px;line-height:20px;">${backupLabel}</p>`,
    `<p style="margin:0;font-size:12px;line-height:20px;overflow-wrap:anywhere;word-break:break-all;"><a href="${escapeHtml(url)}" style="color:#6b7280;text-decoration:underline;">${escapeHtml(url)}</a></p>`,
  ].join("");
}

export function renderMailTemplate(
  templateId: string,
  variables: MailTemplateVariables = {},
  locale?: string,
): RenderedMailTemplate {
  assertTemplateId(templateId);

  const { filename, effectiveLocale } = resolveTemplate(templateId, locale);
  const template = parseTemplateFile(readTemplateFile(filename));
  const htmlLang = getLocaleMeta(effectiveLocale).htmlLang;
  const baseUrl = resolveBaseUrl(variables);
  const subject = interpolateRaw(template.metadata.subject, variables);
  const heading =
    interpolateRaw(template.metadata.heading, variables) || subject;
  const preview = interpolateRaw(template.metadata.preview, variables);
  const action = interpolateRaw(template.metadata.action, variables);
  const url = interpolateRaw(template.metadata.url, variables);
  const bodyHtml = interpolateEscaped(template.body, variables);
  const layoutHtml = interpolateEscaped(readTemplateFile("layout.html"), {
    actionHtml: buildActionHtml(action, url, effectiveLocale),
    baseUrl,
    baseUrlLabel: baseUrl.replace(/^https?:\/\//, ""),
    bodyHtml,
    heading,
    htmlLang,
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
