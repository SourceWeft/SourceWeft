import ts from "typescript";
import { VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES } from "./layout-source";
import { VIDEO_SCENE_COMPONENT_NAME } from "./config";

const LAYOUT_PRIMITIVE_LIST = VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES.join(", ");

export const LAYOUT_PRIMITIVES_PROMPT_LINE = `These layout globals are also available (no import needed): ${LAYOUT_PRIMITIVE_LIST}.`;

export const LAYOUT_PRIMITIVES_IMPORT_STATEMENT = `import { ${LAYOUT_PRIMITIVE_LIST} } from "./layout-primitives";`;

export function normalizeSceneProjectCode(code: string) {
  const withoutAllowedImports = code
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["']react["'];?\s*$/gm, "")
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["']remotion["'];?\s*$/gm, "")
    .replace(
      /^\s*import\s+[\s\S]*?\s+from\s+["']\.\/layout-primitives["'];?\s*$/gm,
      "",
    );
  return [
    'import React, { type CSSProperties } from "react";',
    'import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";',
    LAYOUT_PRIMITIVES_IMPORT_STATEMENT,
    "",
    withoutAllowedImports.trim(),
  ].join("\n");
}

export function typescriptSceneSyntaxDiagnostics(code: string) {
  const result = ts.transpileModule(normalizeSceneProjectCode(code), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "VideoScene.tsx",
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    )
    .filter(Boolean)
    .slice(0, 12);
}

const DANGEROUS_SCENE_IDENTIFIERS = new Set([
  "Audio",
  "Blob",
  "BroadcastChannel",
  "Deno",
  "EventSource",
  "Function",
  "Image",
  "MessageChannel",
  "MessagePort",
  "MutationObserver",
  "Object",
  "Proxy",
  "Reflect",
  "RTCPeerConnection",
  "RTCSessionDescription",
  "SharedWorker",
  "URL",
  "WebAssembly",
  "WebSocket",
  "WebTransport",
  "Worker",
  "XMLHttpRequest",
  "__proto__",
  "constructor",
  "createElement",
  "document",
  "eval",
  "fetch",
  "globalThis",
  "history",
  "indexedDB",
  "localStorage",
  "location",
  "navigator",
  "open",
  "opener",
  "parent",
  "postMessage",
  "process",
  "prototype",
  "self",
  "sendBeacon",
  "sessionStorage",
  "setInterval",
  "setImmediate",
  "setTimeout",
  "top",
  "window",
  "frames",
  "caches",
  "chrome",
  "cookieStore",
  "jsx",
  "jsxs",
]);

const DANGEROUS_SCENE_TAGS = new Set([
  "a",
  "audio",
  "base",
  "embed",
  "form",
  "iframe",
  "image",
  "img",
  "link",
  "meta",
  "object",
  "script",
  "source",
  "style",
  "video",
]);

const DANGEROUS_SCENE_PROPS = new Set([
  "action",
  "dangerouslySetInnerHTML",
  "formAction",
  "href",
  "httpEquiv",
  "ping",
  "poster",
  "ref",
  "srcDoc",
  "srcSet",
  "xlinkHref",
]);

/**
 * Reject browser capabilities that authored scene code does not need. This is
 * deliberately structural rather than a source substring denylist: computed
 * property access is forbidden, so constructor/global escape spellings cannot
 * be assembled at runtime. Trusted layout and Remotion primitives remain the
 * only route to pixels and local, digest-bound assets.
 */
export function sceneRuntimeSafetyDiagnostics(code: string) {
  const sourceFile = ts.createSourceFile(
    "VideoScene.tsx",
    code,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const diagnostics = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isElementAccessExpression(node) || ts.isComputedPropertyName(node)) {
      diagnostics.add("Computed property access is not allowed in scene code");
    }
    if (
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isFunctionExpression(node.expression) ||
          ts.isArrowFunction(node.expression)))
    ) {
      diagnostics.add("Dynamic code or module construction is not allowed");
    }
    if (
      ts.isIdentifier(node) &&
      (DANGEROUS_SCENE_IDENTIFIERS.has(node.text) || node.text.startsWith("__"))
    ) {
      diagnostics.add(`Browser capability is not allowed: ${node.text}`);
    }
    if (ts.isStringLiteralLike(node)) {
      const value = node.text.toLowerCase();
      if (DANGEROUS_SCENE_IDENTIFIERS.has(node.text)) {
        diagnostics.add(`Browser capability is not allowed: ${node.text}`);
      }
      if (
        value.includes("http://") ||
        value.includes("https://") ||
        value.startsWith("//") ||
        value.includes("data:text/html") ||
        /\burl\s*\(/u.test(value)
      ) {
        diagnostics.add("Remote or navigable string values are not allowed");
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node)
        ? node.openingElement.tagName.getText(sourceFile)
        : node.tagName.getText(sourceFile);
      if (DANGEROUS_SCENE_TAGS.has(tag.toLowerCase())) {
        diagnostics.add(`Browser element is not allowed: <${tag}>`);
      }
      const attributes = ts.isJsxElement(node)
        ? node.openingElement.attributes
        : node.attributes;
      for (const attribute of attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const name = attribute.name.getText(sourceFile);
        if (DANGEROUS_SCENE_PROPS.has(name) || /^on[A-Z]/u.test(name)) {
          diagnostics.add(
            `Browser-capability JSX prop is not allowed: ${name}`,
          );
        }
        if (
          name === "style" &&
          (!attribute.initializer ||
            !ts.isJsxExpression(attribute.initializer) ||
            !attribute.initializer.expression ||
            !ts.isObjectLiteralExpression(attribute.initializer.expression))
        ) {
          diagnostics.add("Scene style props must be inline object literals");
        }
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sourceFile).replaceAll(/["']/gu, "");
      if (
        [
          "backgroundImage",
          "cursor",
          "listStyleImage",
          "mask",
          "maskImage",
        ].includes(name) ||
        (name === "background" && !ts.isStringLiteralLike(node.initializer))
      ) {
        diagnostics.add(`Network-capable style is not allowed: ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...diagnostics];
}

/** Static source acceptance used before the sandbox owns real bundling. */
export function basicSceneCheck(code: string) {
  const diagnostics: string[] = [];
  const trimmed = code.trim();
  if (!trimmed) diagnostics.push("Empty scene code");
  if (trimmed.includes("```")) {
    diagnostics.push("Scene code still contains markdown fences");
  }
  const firstCodeToken = trimmed.match(
    /\b(import|export|function|const|let)\b/u,
  );
  if (
    firstCodeToken &&
    firstCodeToken.index !== undefined &&
    firstCodeToken.index > 0
  ) {
    diagnostics.push("Scene code contains prose before the first code token");
  }
  if (!trimmed.includes("export default")) {
    diagnostics.push(
      `Missing default export for ${VIDEO_SCENE_COMPONENT_NAME}`,
    );
  }
  if (!trimmed.includes(VIDEO_SCENE_COMPONENT_NAME)) {
    diagnostics.push(`Missing component name ${VIDEO_SCENE_COMPONENT_NAME}`);
  }
  if (!trimmed.includes("AbsoluteFill")) {
    diagnostics.push("Missing AbsoluteFill root layout");
  }
  if (!trimmed.includes("useCurrentFrame")) {
    diagnostics.push("Missing useCurrentFrame for motion timing");
  }
  diagnostics.push(...sceneRuntimeSafetyDiagnostics(trimmed));
  const invalidImport = [
    ...trimmed.matchAll(/import\s+[\s\S]*?\s+from\s+["']([^"']+)["']/gu),
  ]
    .map((match) => match[1])
    .filter(
      (source) =>
        source !== "react" &&
        source !== "remotion" &&
        source !== "./layout-primitives",
    );
  for (const source of invalidImport) {
    diagnostics.push(`Unsupported import: ${source}`);
  }

  diagnostics.push(...typescriptSceneSyntaxDiagnostics(trimmed));

  const pairs: Array<[string, string, string]> = [
    ["{", "}", "brace"],
    ["(", ")", "parenthesis"],
    ["[", "]", "bracket"],
  ];
  for (const [open, close, name] of pairs) {
    let count = 0;
    for (const char of trimmed) {
      if (char === open) count += 1;
      if (char === close) count -= 1;
      if (count < 0) {
        diagnostics.push(`Unmatched closing ${name}`);
        break;
      }
    }
    if (count !== 0) diagnostics.push(`Unbalanced ${name}: ${count}`);
  }

  return diagnostics;
}
