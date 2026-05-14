import type { Metadata } from "next";

import { LegalPage } from "../_legal/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service | SourceWeft",
  description: "Terms of Service for SourceWeft.",
  alternates: {
    canonical: "https://sourceweft.com/terms",
  },
};

const sections = [
  {
    title: "Introduction",
    body: [
      "These Terms of Service govern your access to and use of SourceWeft, including our website, applications, APIs, and related services. By using SourceWeft, you agree to these Terms.",
      "If you are using SourceWeft on behalf of an organization, you represent that you have authority to accept these Terms for that organization.",
    ],
  },
  {
    title: "Using SourceWeft",
    body: [
      "You may use SourceWeft only in compliance with these Terms, applicable laws, and any product policies or documentation we make available. You are responsible for the information you upload, connect, submit, generate, or share through the service.",
    ],
    items: [
      "Do not use SourceWeft to violate laws, infringe rights, distribute malware, abuse systems, or attempt unauthorized access.",
      "Do not submit content you do not have the right to process or share.",
      "Do not interfere with service integrity, rate limits, billing systems, security controls, or other users.",
      "Do not use generated output as a substitute for professional legal, medical, financial, or safety advice.",
    ],
  },
  {
    title: "Accounts and Organizations",
    body: [
      "You are responsible for keeping your account credentials secure and for all activity under your account. You must provide accurate account and billing information and keep it current.",
      "Organization administrators may manage members, access, workspaces, billing, and related settings. If your account is part of an organization, your use may also be subject to that organization's policies.",
    ],
  },
  {
    title: "Your Content",
    body: [
      "You retain ownership of the files, prompts, messages, outputs, and other content you submit to SourceWeft. You grant SourceWeft the rights needed to host, process, transmit, display, and otherwise use your content solely to provide, maintain, secure, and improve the service.",
      "You are responsible for reviewing AI-generated output before relying on it. AI systems can produce inaccurate, incomplete, or unexpected results.",
    ],
  },
  {
    title: "Subscriptions, Credits, and Billing",
    body: [
      "Some SourceWeft features may require a paid subscription, credits, usage limits, or third-party provider costs. Pricing, included usage, billing cycles, renewals, taxes, and cancellation terms are shown in the product or during checkout.",
      "Unless otherwise stated, fees are non-refundable except where required by law. We may change pricing or plan features with reasonable notice.",
    ],
  },
  {
    title: "Third-Party Services",
    body: [
      "SourceWeft may integrate with third-party services, including model providers, storage services, search tools, authentication services, payment processors, and user-connected accounts. Your use of those services may be governed by separate terms and privacy policies.",
      "We are not responsible for third-party services outside our control, but we use commercially reasonable care when selecting infrastructure providers for SourceWeft.",
    ],
  },
  {
    title: "Intellectual Property",
    body: [
      "SourceWeft and its software, design, trademarks, documentation, and service materials are owned by SourceWeft or its licensors. These Terms do not grant you any ownership rights in SourceWeft.",
      "Subject to your compliance with these Terms, we grant you a limited, non-exclusive, non-transferable right to access and use SourceWeft for your internal personal or business purposes.",
    ],
  },
  {
    title: "Service Changes and Termination",
    body: [
      "We may modify, suspend, or discontinue parts of SourceWeft as the product evolves. We may suspend or terminate access if you violate these Terms, create risk for the service, fail to pay amounts due, or use SourceWeft in a way that could harm other users or third parties.",
      "You may stop using SourceWeft at any time. Where reasonably possible, we will provide ways to export or delete your content, subject to legal, security, and technical limitations.",
    ],
  },
  {
    title: "Disclaimers and Limitation of Liability",
    body: [
      "SourceWeft is provided on an \"as is\" and \"as available\" basis. To the maximum extent permitted by law, we disclaim warranties of merchantability, fitness for a particular purpose, non-infringement, and uninterrupted or error-free operation.",
      "To the maximum extent permitted by law, SourceWeft will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, revenues, data, or goodwill.",
    ],
  },
  {
    title: "Contact",
    body: [
      "If you have questions about these Terms, contact us at support@sourceweft.com.",
    ],
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      description="The rules and responsibilities that apply when you access or use SourceWeft."
      sections={sections}
    />
  );
}
