const URL_ATTRIBUTE_NAMES = new Set([
  "action",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
  "xlink:href",
  "background",
]);

function isJavascriptUrl(value: string) {
  return value.trim().toLowerCase().startsWith("javascript:");
}

function containsUnsafeStyleUrl(value: string) {
  return /url\s*\(\s*(['"]?)\s*javascript:/i.test(value);
}

export function stripExecutableVisualDeckHtmlForExport(html: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  doc.querySelectorAll("script").forEach((script) => script.remove());

  for (const element of Array.from(doc.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on") || name === "srcdoc") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (URL_ATTRIBUTE_NAMES.has(name) && isJavascriptUrl(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style" && containsUnsafeStyleUrl(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
