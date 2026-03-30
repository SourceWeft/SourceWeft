import { EmailTemplate } from "@daveyplate/better-auth-ui/server";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type LinkTemplateInput = {
  title: string;
  message: string;
  buttonLabel: string;
  buttonUrl: string;
};

type OtpTemplateInput = {
  title: string;
  message: string;
  otp: string;
};

function renderEmailTemplate(input: {
  heading: string;
  action?: string;
  url?: string;
  preview?: string;
  content: ReactNode;
}) {
  const html = renderToStaticMarkup(
    createElement(EmailTemplate, {
      action: input.action,
      content: input.content,
      heading: input.heading,
      preview: input.preview,
      siteName: "VelaMind",
      url: input.url,
      variant: "vercel",
    }),
  );

  return `<!DOCTYPE html>${html}`;
}

export function renderLinkTemplate(input: LinkTemplateInput) {
  return renderEmailTemplate({
    heading: input.title,
    action: input.buttonLabel,
    preview: input.title,
    url: input.buttonUrl,
    content: createElement("p", null, input.message),
  });
}

export function renderOtpTemplate(input: OtpTemplateInput) {
  return renderEmailTemplate({
    heading: input.title,
    preview: `${input.title} - ${input.otp}`,
    content: createElement(
      "div",
      {
        style: {
          display: "grid",
          gap: "16px",
        },
      },
      createElement("p", null, input.message),
      createElement(
        "p",
        {
          style: {
            color: "#111827",
            fontSize: "32px",
            fontWeight: 700,
            letterSpacing: "6px",
            margin: 0,
            textAlign: "center",
          },
        },
        input.otp,
      ),
      createElement(
        "p",
        {
          style: {
            color: "#6b7280",
            fontSize: "12px",
            margin: 0,
          },
        },
        "This code expires soon and can only be used once.",
      ),
    ),
  });
}
