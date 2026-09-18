import {
  DEFAULT_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "../../seo";

type JsonLdProps = {
  data: Record<string, unknown>;
};

/** Third-party strings reach this markup, so `</script>` must never survive serialization. */
export function JsonLd({ data }: JsonLdProps) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data)
          .replaceAll("<", "\\u003c")
          .replaceAll("\u2028", "\\u2028")
          .replaceAll("\u2029", "\\u2029"),
      }}
    />
  );
}

export function SeoJsonLd() {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Organization",
          description: DEFAULT_DESCRIPTION,
          logo: `${SITE_URL}/logo.svg`,
          name: SITE_NAME,
          url: SITE_URL,
        }}
      />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebSite",
          description: DEFAULT_DESCRIPTION,
          name: SITE_NAME,
          url: SITE_URL,
        }}
      />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          applicationCategory: "ProductivityApplication",
          description: DEFAULT_DESCRIPTION,
          featureList: [
            "AI notebook workspace for connected knowledge sources",
            "Source-grounded answers with citations",
            "Study guides, FAQs, briefings, and timelines from uploaded sources",
            "Audio overviews from documents and connected tools",
            "Knowledge source connections for tools like Notion, Google Drive, Gmail, and Slack",
          ],
          name: SITE_NAME,
          operatingSystem: "Web, macOS, Windows",
          url: SITE_URL,
        }}
      />
    </>
  );
}
