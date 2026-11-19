/** Class on `<html>` while the iOS app's launch cover is up. */
export const LAUNCH_COVER_CLASS = "sw-app-launching";

// The same look as the app's bundled splash page (apps/mobile/placeholder-dist/splash.html)
// and launch image: centred logo (the same mark as the app's Logo, without the name), loading
// bar, system light or dark background.
const LOGO_LIGHT = `url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20800%20800%22%3E%3Crect%20width%3D%22800%22%20height%3D%22800%22%20rx%3D%22150%22%20fill%3D%22%230a0a0a%22%2F%3E%3Cpath%20transform%3D%22translate%28108%20108%29%20scale%280.73%29%22%20fill%3D%22%23ffffff%22%20d%3D%22M766.6%20125.674h-83.275L624.072%20376.14l48.525%20141.407zM436.545%20256.192h-80.873l128.916%20418.137h32.83l24.822-86.477zm88.88%200-24.662%2085.677%20102.492%20332.46h34.751l19.698-86.477-104.094-331.66zm-129.717-33.63v-96.888H200.813q-88.238.16-128.115%2041.958Q31.86%20209.59%2033.462%20274.128t42.6%2095.446q31.068%2023.38%2075.268%2048.205l106.814%2056.53q46.282%2025.143%2038.275%2062.937-8.167%2037.634-57.172%2039.556H36.185v97.527h215.073q48.202-2.562%2081.674-22.902%2053.168-32.51%2065.178-101.371%2010.89-93.843-76.709-148.934-111.3-61.015-165.909-99.45-27.545-19.377-18.897-47.724%209.449-31.388%2058.933-31.388h200.18z%22%2F%3E%3C%2Fsvg%3E")`;
const LOGO_DARK = `url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20800%20800%22%3E%3Crect%20width%3D%22800%22%20height%3D%22800%22%20rx%3D%22150%22%20fill%3D%22%23fafafa%22%2F%3E%3Cpath%20transform%3D%22translate%28108%20108%29%20scale%280.73%29%22%20fill%3D%22%23171717%22%20d%3D%22M766.6%20125.674h-83.275L624.072%20376.14l48.525%20141.407zM436.545%20256.192h-80.873l128.916%20418.137h32.83l24.822-86.477zm88.88%200-24.662%2085.677%20102.492%20332.46h34.751l19.698-86.477-104.094-331.66zm-129.717-33.63v-96.888H200.813q-88.238.16-128.115%2041.958Q31.86%20209.59%2033.462%20274.128t42.6%2095.446q31.068%2023.38%2075.268%2048.205l106.814%2056.53q46.282%2025.143%2038.275%2062.937-8.167%2037.634-57.172%2039.556H36.185v97.527h215.073q48.202-2.562%2081.674-22.902%2053.168-32.51%2065.178-101.371%2010.89-93.843-76.709-148.934-111.3-61.015-165.909-99.45-27.545-19.377-18.897-47.724%209.449-31.388%2058.933-31.388h200.18z%22%2F%3E%3C%2Fsvg%3E")`;
export const LAUNCH_COVER_STYLE = `
html.${LAUNCH_COVER_CLASS}::before {
  content: ""; position: fixed; inset: 0; z-index: 2147483647;
  background: ${LOGO_LIGHT} center / 64px 64px no-repeat, #ffffff;
}
html.${LAUNCH_COVER_CLASS}::after {
  content: ""; position: fixed; z-index: 2147483647; left: 50%; top: calc(50% + 52px);
  width: 44px; height: 3px; margin-left: -22px; border-radius: 2px;
  background: linear-gradient(90deg, transparent 0 30%, currentColor 30% 70%, transparent 70%) 0 0 / 250% 100%, rgba(115,115,115,.35);
  color: #000000; animation: sw-launch-bar 1.1s ease-in-out infinite;
}
@media (prefers-color-scheme: dark) {
  html.${LAUNCH_COVER_CLASS}::before { background: ${LOGO_DARK} center / 64px 64px no-repeat, #171717; }
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
