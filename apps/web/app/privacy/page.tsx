import type { Metadata } from "next";

import { LegalPage } from "../_landing/legal/legal-page";
import { OG_IMAGE, SITE_NAME, SITE_URL } from "../seo";

const title = "Privacy Policy | SourceWeft";
const description =
  "How SourceWeft handles account information, connected knowledge sources, workspace content, AI provider processing, retention, and security.";
const canonicalUrl = `${SITE_URL}/privacy`;

export const metadata: Metadata = {
  // `absolute` bypasses the root layout's "%s | SourceWeft" template, which
  // would otherwise suffix the site name a second time.
  title: { absolute: title },
  description,
  alternates: {
    canonical: canonicalUrl,
  },
  openGraph: {
    description,
    images: [OG_IMAGE],
    siteName: SITE_NAME,
    title,
    type: "website",
    url: canonicalUrl,
  },
  twitter: {
    card: "summary_large_image",
    description,
    images: [OG_IMAGE.url],
    title,
  },
};

const sections = [
  {
    title: "Introduction",
    body: [
      "SourceWeft helps people collect, organize, and work with their own sources using AI-assisted workflows. This Privacy Policy explains what information we collect, how we use it, and the choices you have when you use our website, applications, and related services.",
      "By using SourceWeft, you acknowledge that you have read and understood this Privacy Policy. We may update it from time to time, and the updated version will be posted on this page.",
    ],
  },
  {
    title: "Information We Collect",
    body: [
      "We collect information you provide directly, information generated through your use of the product, and limited technical information needed to keep SourceWeft reliable and secure.",
    ],
    items: [
      "Account information, such as your name, email address, authentication details, organization membership, and billing status.",
      "Workspace content, such as uploaded files, connected sources, prompts, chat messages, generated outputs, citations, and metadata you choose to store in SourceWeft.",
      "Usage information, such as feature interactions, source indexing status, model selections, credit usage, and product diagnostics.",
      "Technical information, such as IP address, device and browser type, operating system, log data, cookies, and similar technologies.",
      "Payment information handled by our payment providers, including subscription status, invoices, and transaction metadata.",
    ],
  },
  {
    title: "How We Use Information",
    body: [
      "We use information to provide, secure, maintain, and improve SourceWeft. We do not use your private workspace content to advertise to you.",
    ],
    items: [
      "Provide core product features, including source ingestion, retrieval, AI chat, citations, collaboration, billing, and account management.",
      "Process authentication, organization access, customer support requests, payments, and service communications.",
      "Monitor reliability, prevent abuse, debug errors, measure product performance, and protect the security of users and the service.",
      "Improve SourceWeft through aggregated analytics, product research, and user feedback. We use Google Analytics (via Google Tag Manager, which uses cookies) and Umami (cookieless) to measure product usage; analytics events contain no message content, file names, or email addresses.",
      "Comply with legal obligations and enforce our Terms of Service.",
    ],
  },
  {
    title: "AI Providers and Connected Services",
    body: [
      "SourceWeft may process your prompts, files, retrieved context, and generated outputs through AI model providers, embedding providers, search providers, storage providers, payment processors, authentication providers, and other infrastructure vendors that help us operate the service.",
      "When you connect third-party accounts or use your own API keys, the information exchanged with those services is governed by both this policy and the terms and privacy practices of the relevant third party.",
    ],
  },
  {
    title: "Gmail Connection and Google User Data",
    body: [
      "If you connect Gmail, SourceWeft requests two permissions from Google: to read your mailbox and to send email on your behalf. With them SourceWeft accesses message metadata (sender, recipients, date, subject, and labels), the content of messages and threads that you ask about or select for indexing, and your list of labels. SourceWeft does not request permission to modify, label, archive, or delete your mail, and it does not do so.",
      "SourceWeft uses this data only to provide the features you see. Live search reads message metadata and fetches a selected message or thread when you ask for it. A live lookup does not by itself create an indexed workspace source; content used in a conversation follows the conversation's normal retention and AI processing settings.",
      "Mailbox indexing is off until you enable it. If enabled, SourceWeft stores content and metadata from the selected date and label scope as workspace sources and may process that content for search and retrieval. Scheduled refresh requires a separate choice.",
      "SourceWeft sends a new email through your connected Gmail account only after you review and approve that message's sender, recipients, subject, and body. It does not send automatically, in bulk, or on a schedule.",
      "To produce an answer, SourceWeft sends the message content involved in your request to the AI model provider that runs the model for that conversation. To index and search mail, it sends the selected content to the embedding and reranking providers that turn text into search vectors and rank results. These providers receive the content only to return the requested result. If you run a conversation on a model through your own provider account or API key, that conversation's content is sent to the provider you chose, under your agreement with it.",
      "SourceWeft does not sell Google user data, does not transfer it to advertisers or data brokers, and does not use or transfer it for advertising or for credit or lending decisions. SourceWeft does not use Google user data to develop, improve, or train generalized AI or machine-learning models, and for the models SourceWeft provides, content from your Gmail account is sent only to providers that do not use it to train their models.",
      "SourceWeft does not allow people to read your Gmail data unless you ask us to look at specific content, it is necessary to investigate abuse or a security incident, or the law requires it.",
      "Gmail authorization tokens are encrypted at rest and are not exposed to the browser or to an AI model. Indexed mail is stored with your other workspace sources and is available only to members who can access that workspace.",
      "You can turn off live search or indexing, or remove the connection, at any time. Removing it offers two choices. Disabling the connection stops all Gmail access and keeps the sources already indexed until you delete them. Deleting the connection and its indexed content deletes the stored authorization, the connection, its sync history, and every source, document, and search index entry created from your mail. Mail content that already appears in a conversation remains part of that conversation until you delete the conversation. You can also revoke SourceWeft's access at any time in your Google Account under third-party connections.",
      "SourceWeft's use of information received from Google Workspace APIs adheres to the Google API Services User Data Policy, including its Limited Use requirements.",
    ],
  },
  {
    title: "Data Retention",
    body: [
      "We retain information for as long as needed to provide the service, maintain business records, comply with legal obligations, resolve disputes, and enforce agreements. You may delete workspace content or request account deletion where available, subject to legal, security, and backup retention requirements.",
    ],
  },
  {
    title: "Security",
    body: [
      "We use technical and organizational safeguards designed to protect information against unauthorized access, loss, misuse, alteration, or disclosure. No internet service can be guaranteed to be completely secure, so you should use strong authentication practices and avoid storing content you are not authorized to process.",
    ],
  },
  {
    title: "Your Choices and Rights",
    body: [
      "Depending on where you live, you may have rights to access, correct, delete, export, or object to certain processing of your personal information. You can also manage account settings, connected services, and communication preferences within SourceWeft where those controls are available.",
      "To exercise privacy rights or ask questions about your data, contact us using the details below. We may need to verify your identity before completing a request.",
    ],
  },
  {
    title: "Contact",
    body: [
      "If you have questions about this Privacy Policy or SourceWeft privacy practices, contact us at support@sourceweft.com.",
    ],
  },
];

export default function PrivacyPolicyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      description="How SourceWeft collects, uses, protects, and handles information when you use the product."
      lastUpdated="November 14, 2026"
      sections={sections}
    />
  );
}
