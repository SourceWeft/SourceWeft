/**
 * Class on `<html>` when the page is shown inside a frame, such as the mobile app's sheet
 * for terms and privacy. Pages hide their own site chrome under it, because the frame's
 * host already gives the page a title bar.
 */
export const FRAMED_PAGE_CLASS = "sw-framed";

// Runs before the page paints, so the chrome is never shown and then removed.
export const FRAMED_PAGE_SCRIPT = `(function(){try{if(window.self!==window.top)document.documentElement.classList.add("${FRAMED_PAGE_CLASS}")}catch(e){document.documentElement.classList.add("${FRAMED_PAGE_CLASS}")}})();`;
