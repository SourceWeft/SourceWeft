/** Class on `<html>` while the iOS app's launch cover is up. */
export const LAUNCH_COVER_CLASS = "sw-app-launching";

// The same look as the app's bundled splash page (apps/mobile/placeholder-dist/splash.html)
// and launch image: centred wordmark, loading bar, system light or dark background.
export const LAUNCH_COVER_STYLE = `
html.${LAUNCH_COVER_CLASS}::before {
  content: "SourceWeft"; position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: #ffffff; color: #000000;
  font: 600 22px/27px -apple-system, BlinkMacSystemFont, sans-serif;
}
html.${LAUNCH_COVER_CLASS}::after {
  content: ""; position: fixed; z-index: 2147483647; left: 50%; top: calc(50% + 32px);
  width: 44px; height: 3px; margin-left: -22px; border-radius: 2px;
  background: linear-gradient(90deg, transparent 0 30%, currentColor 30% 70%, transparent 70%) 0 0 / 250% 100%, rgba(115,115,115,.35);
  color: #000000; animation: sw-launch-bar 1.1s ease-in-out infinite;
}
@media (prefers-color-scheme: dark) {
  html.${LAUNCH_COVER_CLASS}::before { background: #171717; color: #ffffff; }
  html.${LAUNCH_COVER_CLASS}::after { color: #ffffff; }
}
@keyframes sw-launch-bar { from { background-position: 100% 0, 0 0; } to { background-position: -100% 0, 0 0; } }
`;

// Runs before the page paints. Only the mobile app's bridge (injected at document start)
// turns the cover on; the website never shows it. MobileAppRuntime lifts it once React has
// rendered, and the timeout lifts it if the page's scripts never run.
export const LAUNCH_COVER_SCRIPT = `(function(){try{var b=window.__SOURCEWEFT_NATIVE__;if(!b||b.kind!=="mobile")return;var r=document.documentElement;r.classList.add("${LAUNCH_COVER_CLASS}");setTimeout(function(){r.classList.remove("${LAUNCH_COVER_CLASS}")},10000)}catch(e){}})();`;

/** Lifts the cover after the next two frames, once React's first render is on screen. */
export function liftMobileLaunchCover() {
  const root = document.documentElement;
  if (!root.classList.contains(LAUNCH_COVER_CLASS)) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.classList.remove(LAUNCH_COVER_CLASS)),
  );
}
