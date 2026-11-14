import association from "./association.json";

export const dynamic = "force-static";

/**
 * Apple's association file for universal links: it names the iOS app that may
 * open this site's dashboard pages. iOS fetches it through Apple's CDN when the
 * app is installed, and requires a direct 200 response with a JSON content
 * type, so this path must never redirect.
 *
 * The app only opens the pages listed here (`apps/mobile/src-tauri/src/lib.rs`,
 * `universal_link_target`); sign-in pages are deliberately left out.
 */
export function GET() {
  return Response.json(association, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
