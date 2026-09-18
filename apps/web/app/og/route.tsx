import { ImageResponse } from "next/og";

import { DEFAULT_DESCRIPTION, SITE_NAME } from "../seo";

export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#0a0a0a",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "center",
          padding: "80px",
          width: "100%",
        }}
      >
        <div
          style={{
            color: "#ffffff",
            display: "flex",
            fontSize: 96,
            letterSpacing: -2,
          }}
        >
          {SITE_NAME}
        </div>
        <div
          style={{
            color: "#a1a1aa",
            display: "flex",
            fontSize: 34,
            marginTop: 28,
            maxWidth: 920,
            textAlign: "center",
          }}
        >
          {DEFAULT_DESCRIPTION}
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
