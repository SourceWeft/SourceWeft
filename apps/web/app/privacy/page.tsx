import type { Metadata } from "next";

import { LegalPage } from "../_legal/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy | SourceWeft",
  description: "Privacy Policy for SourceWeft.",
  alternates: {
    canonical: "https://sourceweft.com/privacy",
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
      "Improve SourceWeft through aggregated analytics, product research, and user feedback.",
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
      sections={sections}
    />
  );
}
